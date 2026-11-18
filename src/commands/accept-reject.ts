// baton accept / reject commands. Spec §6.6.
// P0-11: rejected has follow_up_task (string, not boolean)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { withLock } from '../io/lock.js';
import { appendLedger, readLedger, nextEventId } from '../io/ledger-file.js';
import { getCommitSha, git } from '../io/git.js';
import { replay, type TaskStatus } from '../core/ledger-replay.js';
import { taskTemplate } from '../templates/index.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';

function loadDefaultBranch(text: string): string {
  const raw = yaml.parse(text);
  return raw?.default_branch ?? 'main';
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

async function listTaskIds(repoRoot: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(repoRoot, 'project-memory/tasks');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files.filter(f => /^T-\d{4}\.md$/.test(f)).map(f => f.replace(/\.md$/, ''));
}

export interface AcceptResult {
  taskId: string;
  commit: string;
  override?: string;
}

export async function accept(
  repoRoot: string,
  taskId: string,
  opts: { override?: string; allowBranch?: boolean } = {},
): Promise<AcceptResult> {
  // Load default branch from policy
  let baseBranch = 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    baseBranch = loadDefaultBranch(policyText);
  } catch { /* use default */ }
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });

  return withLock(repoRoot, async () => {
    const { events } = await readLedger(repoRoot);
    const state = replay(events);
    const t = state.tasks.get(taskId);
    if (!t) {
      const err = new Error(`task ${taskId} not found or not locked`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    const currentStatus = t.status as TaskStatus;
    const status = currentStatus;

    // §6.6: accept requires status in_review, OR override with non-empty reason from needs_work
    if (status === 'in_review' && !opts.override) {
      // OK
    } else if (opts.override && opts.override.length > 0 && status === 'needs_work') {
      // OK with override
    } else if (status === 'in_review' && opts.override) {
      // override on in_review is allowed but unusual
    } else {
      const err = new Error(`accept requires status in_review (current: ${status}).${opts.override ? '' : ' Use --override "<reason>" to override from needs_work.'}`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    // Verify latest verify_run head == current branch tip
    // (For Stage 2 we use the latest verify_run head directly)
    if (!t.latestVerifyHead) {
      const err = new Error(`no verify_run for ${taskId}. Run: baton verify ${taskId}`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    // Get current branch tip (assume worker branch is checked out, or use latest verify head)
    // For Stage 2 we accept the latest verify_run head as the current tip
    let commit = t.latestVerifyHead;

    // P1 (v1.2 §6): force-push detection. When the current branch is a baton worker
    // branch and the verified head is no longer reachable from its tip, the branch
    // was rewritten after verify — fail with a re-verify hint instead of accepting
    // a stale head.
    try {
      const curBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })).stdout.trim();
      if (curBranch.startsWith('baton/') && curBranch !== 'HEAD') {
        const tip = (await git(['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot })).stdout.trim();
        if (tip && tip !== commit) {
          const ancestor = await git(['merge-base', '--is-ancestor', commit, tip], { cwd: repoRoot });
          if (ancestor.exitCode !== 0) {
            const err = new Error(
              `branch ${curBranch} moved since verify (verified head ${commit.slice(0, 12)} is not reachable from tip ${tip.slice(0, 12)}). ` +
              `Re-verify first: baton verify ${taskId} --head ${tip.slice(0, 12)}`
            );
            (err as Error & { exitCode?: number }).exitCode = 4;
            throw err;
          }
        }
      }
    } catch (err) {
      if ((err as Error & { exitCode?: number }).exitCode === 4) throw err;
      // git unavailable or odd state — keep legacy behavior
    }

    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'accepted',
      task: taskId,
      commit,
      override: opts.override ?? null,
    });

    return { taskId, commit, override: opts.override };
  });
}

export interface RejectResult {
  taskId: string;
  reason: string;
  followUpTaskId?: string;
}

export async function reject(
  repoRoot: string,
  taskId: string,
  opts: { reason: string; followUp?: string; allowBranch?: boolean },
): Promise<RejectResult> {
  if (!opts.reason || opts.reason.length === 0) {
    const err = new Error(`reject requires --reason "<text>"`);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }

  // Load default branch from policy
  let baseBranch = 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    baseBranch = loadDefaultBranch(policyText);
  } catch { /* use default */ }
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });

  return withLock(repoRoot, async () => {
    let followUpTaskId: string | undefined;

    if (opts.followUp) {
      // Create follow-up task
      const existing = await listTaskIds(repoRoot);
      const nums = existing.map(s => parseInt(s.split('-')[1] ?? '0', 10)).filter(n => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      followUpTaskId = `T-${String(next).padStart(4, '0')}`;

      // Read rejected task's touches so follow-up inherits scope
      const rejectedTaskPath = path.join(repoRoot, 'project-memory/tasks', `${taskId}.md`);
      let touches: string[] = ['src/**'];
      try {
        const text = await readFile(rejectedTaskPath, 'utf8');
        const { frontMatter } = parseFrontMatter(text);
        if (Array.isArray(frontMatter.touches)) touches = frontMatter.touches as string[];
      } catch { /* use default */ }

      const content = taskTemplate(followUpTaskId, opts.followUp, touches);
      const followUpPath = path.join(repoRoot, 'project-memory/tasks', `${followUpTaskId}.md`);
      await writeFile(followUpPath, content, 'utf8');
    }

    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'rejected',
      task: taskId,
      reason: opts.reason,
      follow_up_task: followUpTaskId,    // P0-11: string, not boolean
    });

    return { taskId, reason: opts.reason, followUpTaskId };
  });
}
