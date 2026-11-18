// baton packet command. Spec §5.4, §5.5.
// baton packet <T-id> [--budget N] [--include-files] [--out <path>]
// Compiles the packet, secret-scans it, writes to stdout or file.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { TaskSchema, type Task, type Policy, PolicySchema } from '../core/schemas.js';
import { compilePacket, scanPacketForSecrets } from '../core/packet-compile.js';
import { readLedger, nextEventId, appendLedger } from '../io/ledger-file.js';
import { sha256Sync } from '../io/hash.js';
import { withLock } from '../io/lock.js';
import { getCommitSha, fileExistsAtRef, readFileAtRef, lsFilesAtRef } from '../io/git.js';
import { replay } from '../core/ledger-replay.js';
import { overlaps, isMatch } from '../core/globs.js';
import { scan } from '../core/secrets.js';
import { searchRepo } from '../core/search.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';

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

async function loadPolicy(repoRoot: string): Promise<Policy> {
  const text = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
  const raw = yaml.parse(text);
  return PolicySchema.parse(raw);
}

async function loadDecisionBodies(repoRoot: string, decisionIds: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const id of decisionIds) {
    try {
      const text = await readFile(path.join(repoRoot, 'project-memory/decisions', `${id}.md`), 'utf8');
      const { body } = parseFrontMatter(text);
      result[id] = body;
    } catch { /* ignore */ }
  }
  return result;
}

export interface PacketResult {
  text: string;
  tokensUsed: number;
  budget: number;
  omitted: string[];
  packetSha: string;
  output: 'stdout' | 'file';
  outputPath?: string;
}

export async function packet(
  repoRoot: string,
  taskId: string,
  opts: { budget?: number; includeFiles?: boolean; out?: string; allowBranch?: boolean; search?: boolean; searchTop?: number } = {},
): Promise<PacketResult> {
  const policy = await loadPolicy(repoRoot);
  const baseBranch = policy.default_branch;
  const budget = opts.budget ?? policy.token_budget;

  // Branch guard: ledger-writing commands refuse unless on base branch
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });

  // Read task file from base branch (G17)
  const taskPath = `project-memory/tasks/${taskId}.md`;
  const existsOnBase = await fileExistsAtRef(repoRoot, baseBranch, taskPath);
  if (!existsOnBase) {
    const err = new Error(`task ${taskId} not found on ${baseBranch}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }
  const taskText = await readFileAtRef(repoRoot, baseBranch, taskPath);
  const { frontMatter } = parseFrontMatter(taskText);
  const task = TaskSchema.parse(frontMatter);

  // Verify task is locked and hash matches
  const { events } = await readLedger(repoRoot);
  const lockedEvents = events
    .filter(e => e.type === 'task_locked' && e.task === taskId)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (lockedEvents.length === 0) {
    const err = new Error(`task ${taskId} is not locked. Run: baton task ready ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  const lastLock = lockedEvents[lockedEvents.length - 1];
  if (!lastLock || !('hash' in lastLock)) {
    const err = new Error(`malformed task_locked event for ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 1;
    throw err;
  }
  const currentHash = sha256Sync(taskText);
  if (lastLock.hash !== currentHash) {
    const err = new Error(`task file changed since lock: locked ${lastLock.hash.slice(0, 12)}, current ${currentHash.slice(0, 12)}. Run: baton task unlock ${taskId} --reason "checks changed", then re-ready.`);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // Build memory for compilePacket
  const baseSha = await getCommitSha(repoRoot, baseBranch);
  const state = replay(events);

  // Load constraints, essentials from STATE.md
  let stateText = '';
  try {
    stateText = await readFile(path.join(repoRoot, 'project-memory/STATE.md'), 'utf8');
  } catch { /* ignore */ }
  // Extract essentials section (between "## Essentials" and next ##)
  const essentialsMatch = stateText.match(/## Essentials for every worker\n([\s\S]*?)(?=\n## |\n<!-- baton:generated|$)/);
  const essentials = essentialsMatch?.[1]?.trim() ?? '';
  const constraintsText = await readFile(path.join(repoRoot, 'project-memory/CONSTRAINTS.md'), 'utf8').catch(() => '');

  // Load reads files
  const readsContents = task.reads ? await Promise.all(task.reads.map(async r => {
    const content = await readFile(path.join(repoRoot, r), 'utf8').catch(() => '');
    return { path: r, content };
  })) : [];

  // Load decision bodies — accepted decisions only.
  // For each accepted decision, load its body text and metadata.
  const acceptedDecisionIds = Array.from(state.decisions.entries())
    .filter(([, d]) => d.status === 'accepted')
    .map(([id]) => id);
  const decisionsWithBodies = await Promise.all(
    acceptedDecisionIds.map(async (id) => {
      const decisionPath = path.join(repoRoot, 'project-memory/decisions', `${id}.md`);
      let decisionText = '';
      try {
        decisionText = await readFile(decisionPath, 'utf8');
      } catch { /* skip missing */ }
      const { frontMatter: dFm, body: dBody } = parseFrontMatter(decisionText);
      return {
        baton_version: 1 as const,
        id,
        title: (dFm.title as string) ?? '',
        key: (dFm.key as string) ?? '',
        areas: Array.isArray(dFm.areas) ? (dFm.areas as string[]) : [],
        status: 'accepted' as const,
        date: (dFm.date as string) ?? '',
        supersedes: typeof dFm.supersedes === 'string' ? dFm.supersedes : undefined,
        body: dBody,
      };
    })
  );

  // Verified claims (not stale)
  const verifiedClaims = Array.from(state.claims.entries())
    .filter(([, c]) => c.status === 'verified')
    .map(([id, c]) => ({
      claim_id: id,
      statement: c.statement,
      key: c.key,
      watch: c.anchor?.watch,
    }));

  // Recent commits touching task.touches
  // (For simplicity, use general recent commits without path filter)
  const recentCommits = ['(use git log --oneline to see commits)'];

  // Last worker on this area: find most recent accepted task touching same areas
  const lastWorker = null; // Stage 2+ enhancement

  // --include-files: load file contents with never_include + per-file secret scan
  let includedFiles: { path: string; content: string }[] = [];
  if (opts.includeFiles) {
    // Resolve files to include. By default include all files matching task.touches.
    // Spec §5.5 T7: file contents added only with --include-files,
    //   only for files that pass the scan, and never for files matching never_include globs.
    const trackedFiles = await lsFilesAtRef(repoRoot, baseBranch);
    const touchedFiles = trackedFiles.filter(f =>
      task.touches.some(t => isMatch(f, t))
    );
    includedFiles = [];
    for (const filePath of touchedFiles) {
      // never_include check (P0-14 extended list)
      const isNeverInclude = policy.never_include.some(g => isMatch(filePath, g));
      if (isNeverInclude) {
        // Skip silently — listed in Omitted line by compilePacket
        continue;
      }
      // Per-file secret scan BEFORE inclusion (issue #19)
      let content: string;
      try {
        content = await readFile(path.join(repoRoot, filePath), 'utf8');
      } catch {
        // File may not exist in working tree (only in base branch) — skip
        continue;
      }
      const findings = scan(content, policy.extra_secret_patterns);
      if (findings.length > 0) {
        // Skip file — don't include secrets in packet
        continue;
      }
      includedFiles.push({ path: filePath, content });
    }
  }

  // --search (v1.3.0): BM25 retrieval tier (T5.5). Query = task title + reads
  // paths. Deterministic, no AI. Corpus already excludes never_include and
  // snippets are secret-masked by core/search.ts.
  let retrieved: { path: string; score: number; snippet: string }[] = [];
  if (opts.search) {
    const query = [task.title, ...(task.reads ?? [])].join(' ');
    const searchResult = await searchRepo(repoRoot, query, {
      top: opts.searchTop ?? 6,
      neverInclude: policy.never_include,
      extraSecretPatterns: policy.extra_secret_patterns,
    });
    // Don't hand the worker snippets of its own touch targets twice — reads
    // and include_files already carry full contents for those.
    retrieved = searchResult.results;
  }

  // Compile
  const result = compilePacket(task, {
    baseSha,
    objective: '',  // Stage 1: workers fill in the body
    constraints: constraintsText,
    essentials,
    reads: readsContents,
    decisions: decisionsWithBodies,    // T3: accepted decision bodies
    conflicts: [],
    verifiedClaims,
    retrieved,
    recentCommits,
    lastWorkerOnArea: lastWorker,
  }, budget, {
    includeFiles: opts.includeFiles,
    files: includedFiles,
  });

  // Secret scan (P0-7 / G26) — block on findings
  const findings = scanPacketForSecrets(result.text, policy);
  if (findings.length > 0) {
    const err = new Error(`packet contains ${findings.length} secret pattern matches. First: ${findings[0]?.name} at line ${findings[0]?.line} (${findings[0]?.masked})`);
    (err as Error & { exitCode?: number }).exitCode = 5;
    throw err;
  }

  // Write to stdout or file
  const packetSha = sha256Sync(result.text);
  let outputPath: string | undefined;
  if (opts.out) {
    outputPath = path.resolve(repoRoot, opts.out);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.text, 'utf8');
  } else {
    // Default: project-memory/packets/<taskId>.md (gitignored)
    outputPath = path.join(repoRoot, 'project-memory/packets', `${taskId}.md`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.text, 'utf8');
  }

  // Record packet_issued event
  await withLock(repoRoot, async () => {
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'packet_issued',
      task: taskId,
      packet_sha256: packetSha,
      budget,
      omitted: result.omitted,
    });
  });

  return {
    text: result.text,
    tokensUsed: result.tokensUsed,
    budget,
    omitted: result.omitted,
    packetSha,
    output: 'file',
    outputPath,
  };
}
