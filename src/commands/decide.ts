// baton decide command. Spec §5.4.
// baton decide "<title>" --key <k> --areas "<glob,glob>" — creates a proposed decision
// baton decide accept|reject <D-id> [--supersedes <D-id>] — changes status
//
// P0-3: decision_status event carries hash of decision file at transition.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { DecisionSchema } from '../core/schemas.js';
import { withLock } from '../io/lock.js';
import { sha256Sync } from '../io/hash.js';
import { appendLedger, readLedger, nextEventId } from '../io/ledger-file.js';
import { fileExistsAtRef, getCommitSha } from '../io/git.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('front matter not found');
  const fm = yaml.parse(m[1] ?? '') as Record<string, unknown>;
  const body = m[2] ?? '';
  return { frontMatter: fm, body };
}

function stringifyFrontMatter(fm: Record<string, unknown>, body: string): string {
  const fmText = yaml.stringify(fm).trim();
  return `---\n${fmText}\n---\n${body}`;
}

async function listDecisionIds(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, 'project-memory/decisions');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter(f => /^D-\d{4}\.md$/.test(f))
    .map(f => f.replace(/\.md$/, ''));
}

export interface DecideNewOpts {
  title: string;
  key: string;
  areas: string[];
  decision?: string;
  why?: string;
  alternatives?: string;
}

export async function decideNew(repoRoot: string, opts: DecideNewOpts & { allowBranch?: boolean; baseBranch?: string }): Promise<string> {
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const existing = await listDecisionIds(repoRoot);
    const nums = existing.map(s => parseInt(s.split('-')[1] ?? '0', 10)).filter(n => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const id = `D-${String(next).padStart(4, '0')}`;

    const fm = {
      baton_version: 1,
      id,
      title: opts.title,
      key: opts.key,
      areas: opts.areas,
      status: 'proposed',
      date: todayUtcDate(),
    };
    // Validate via Zod
    DecisionSchema.parse(fm);

    const body = `\n## Decision\n${opts.decision ?? ''}\n\n## Why\n${opts.why ?? ''}\n\n## Alternatives\n${opts.alternatives ?? ''}\n`;
    const content = stringifyFrontMatter(fm, body);

    const filePath = path.join(repoRoot, 'project-memory/decisions', `${id}.md`);
    await writeFile(filePath, content, 'utf8');

    // Record decision_status event with hash (P0-3)
    const hash = sha256Sync(content);
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'decision_status',
      decision: id,
      from: 'proposed',
      to: 'proposed',
      hash,
    });

    return id;
  });
}

export async function decideAccept(
  repoRoot: string,
  decisionId: string,
  opts: { supersedes?: string; allowBranch?: boolean; baseBranch?: string } = {},
): Promise<void> {
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const filePath = path.join(repoRoot, 'project-memory/decisions', `${decisionId}.md`);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      const err = new Error(`decision not found: ${decisionId}`);
      (err as Error & { exitCode?: number }).exitCode = 3;
      throw err;
    }
    const { frontMatter, body } = parseFrontMatter(text);

    // P0-3: verify hash matches the proposed-time hash
    const { events } = await readLedger(repoRoot);
    const isDecisionStatus = (e: { type: string }): e is { type: 'decision_status'; decision: string; hash: string; from: string; to: string; id: string; ts: string; v: 1 } =>
      e.type === 'decision_status';
    const proposedEvents = events.filter(isDecisionStatus).filter(e => e.decision === decisionId)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    if (proposedEvents.length === 0) {
      const err = new Error(`no decision_status event for ${decisionId}; was it created with baton decide?`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    const firstProposed = proposedEvents[0];
    if (!firstProposed) {
      const err = new Error(`malformed decision_status events for ${decisionId}`);
      (err as Error & { exitCode?: number }).exitCode = 1;
      throw err;
    }
    const proposedHash = firstProposed.hash;
    const currentHash = sha256Sync(text);
    if (proposedHash !== currentHash) {
      const err = new Error(`decision file changed since proposed: locked ${proposedHash.slice(0, 12)}, current ${currentHash.slice(0, 12)}`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    // Update status
    const updatedFm = { ...frontMatter, status: 'accepted' };
    const updatedText = stringifyFrontMatter(updatedFm, body);
    await writeFile(filePath, updatedText, 'utf8');

    const newHash = sha256Sync(updatedText);
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'decision_status',
      decision: decisionId,
      from: 'proposed',
      to: 'accepted',
      hash: newHash,
    });

    // If supersedes another decision, mark that one superseded
    if (opts.supersedes) {
      const oldFilePath = path.join(repoRoot, 'project-memory/decisions', `${opts.supersedes}.md`);
      try {
        const oldText = await readFile(oldFilePath, 'utf8');
        const { frontMatter: oldFm, body: oldBody } = parseFrontMatter(oldText);
        const updatedOldFm = { ...oldFm, status: 'superseded', supersedes: undefined };
        const updatedOldText = stringifyFrontMatter(updatedOldFm, oldBody);
        await writeFile(oldFilePath, updatedOldText, 'utf8');
        const oldHash = sha256Sync(updatedOldText);
        const oldEventId = await nextEventId(repoRoot);
        await appendLedger(repoRoot, {
          v: 1, id: oldEventId, ts: nowIso(),
          type: 'decision_status',
          decision: opts.supersedes,
          from: 'accepted',
          to: 'superseded',
          hash: oldHash,
        });
      } catch {
        // ignore missing supersedes target
      }
    }
  });
}

export async function decideReject(
  repoRoot: string,
  decisionId: string,
  opts: { allowBranch?: boolean; baseBranch?: string } = {},
): Promise<void> {
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const filePath = path.join(repoRoot, 'project-memory/decisions', `${decisionId}.md`);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      const err = new Error(`decision not found: ${decisionId}`);
      (err as Error & { exitCode?: number }).exitCode = 3;
      throw err;
    }
    const { frontMatter, body } = parseFrontMatter(text);
    const updatedFm = { ...frontMatter, status: 'rejected' };
    const updatedText = stringifyFrontMatter(updatedFm, body);
    await writeFile(filePath, updatedText, 'utf8');

    const newHash = sha256Sync(updatedText);
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'decision_status',
      decision: decisionId,
      from: (frontMatter.status as string) ?? 'proposed',
      to: 'rejected',
      hash: newHash,
    });
  });
}
