// baton verify command. Spec §6.4.
// P0-7: missing report = fail (not skip)
// P0-9: worktree path wt-<taskId>-<runId>-<pid>
// P0-13: strength shown in verdict table
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { TaskSchema, PolicySchema, ReportSchema, type Task, type Policy, type Report, type LedgerEvent } from '../core/schemas.js';
import { withLock } from '../io/lock.js';
import { sha256Sync } from '../io/hash.js';
import { appendLedger, readLedger, nextEventId, nextRunId, nextClaimId } from '../io/ledger-file.js';
import {
  git, getCommitSha, fileExistsAtRef, readFileAtRef, isValidRefName,
} from '../io/git.js';
import { runAllChecks, enforceProtectedPaths, type CheckResult } from '../core/check-engine.js';
import { verdict, strengthOf } from '../core/verdicts.js';
import { replay } from '../core/ledger-replay.js';
import { spawn } from 'node:child_process';
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

async function loadPolicyFromBase(repoRoot: string, baseBranch: string): Promise<Policy> {
  const text = await readFileAtRef(repoRoot, baseBranch, '.baton/policy.yml');
  const raw = yaml.parse(text);
  return PolicySchema.parse(raw);
}

async function findWorkerBranch(repoRoot: string, taskId: string): Promise<string | null> {
  // Find branches matching baton/<taskId>-*
  const r = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/baton/'], { cwd: repoRoot });
  if (r.exitCode !== 0) return null;
  const prefix = `baton/${taskId}-`;
  const matches = r.stdout.split('\n').filter(b => b.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) return null;  // ambiguous — caller must use --branch
  return matches[0] ?? null;
}

async function createWorktree(repoRoot: string, taskId: string, runId: string, head: string): Promise<string> {
  // P0-9: wt-<taskId>-<runId>-<pid>
  const pid = process.pid;
  const wtPath = path.join(repoRoot, '.baton', 'tmp', `wt-${taskId}-${runId}-${pid}`);
  await mkdir(path.dirname(wtPath), { recursive: true });
  const r = await git(['worktree', 'add', '--detach', wtPath, head], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr}`);
  }
  return wtPath;
}

async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', wtPath], { cwd: repoRoot });
  } catch {
    // Fallback: remove directory directly
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VerifyResult {
  taskId: string;
  runId: string;
  baseCommit: string;
  headCommit: string;
  branch: string | null;
  results: CheckResult[];
  verdict: 'all_pass' | 'has_failures' | 'incomplete';
  claims: { id: string; statement: string; key?: string; status: 'verified' | 'failed' | 'reported' }[];
}

export async function verify(
  repoRoot: string,
  taskId: string,
  opts: { branch?: string; head?: string; yes?: boolean; allowBranch?: boolean } = {},
): Promise<VerifyResult> {
  // Load policy from base branch (G17)
  const policy = await loadPolicyFromBase(repoRoot, policy_default_branch(repoRoot));
  const baseBranch = policy.default_branch;

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
    const err = new Error(`task file changed since lock: locked ${lastLock.hash.slice(0, 12)}, current ${currentHash.slice(0, 12)}. Worker cannot edit its own checks (G17).`);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // Determine head commit
  let branch: string | null = null;
  let head: string;
  if (opts.head) {
    if (!isValidRefName(opts.head)) {
      const err = new Error(`invalid head: ${opts.head}`);
      (err as Error & { exitCode?: number }).exitCode = 2;
      throw err;
    }
    head = opts.head;
  } else if (opts.branch) {
    if (!isValidRefName(opts.branch)) {
      const err = new Error(`invalid branch name: ${opts.branch}`);
      (err as Error & { exitCode?: number }).exitCode = 2;
      throw err;
    }
    branch = opts.branch;
    head = await getCommitSha(repoRoot, opts.branch);
  } else {
    // Find single branch matching baton/<taskId>-*
    const found = await findWorkerBranch(repoRoot, taskId);
    if (!found) {
      const err = new Error(`could not find single branch matching baton/${taskId}-*. Use --branch <name> or --head <sha>.`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    branch = found;
    head = await getCommitSha(repoRoot, found);
  }

  const baseCommit = await getCommitSha(repoRoot, baseBranch);

  // v1.2 §6.4: M = git merge-base <base> <head>
  // Diff from merge-base, NOT from base tip. This handles the case where main
  // advanced after the worker branched (e.g. a ledger commit landed on main).
  const mergeBaseResult = await git(['merge-base', baseCommit, head], { cwd: repoRoot });
  if (mergeBaseResult.exitCode !== 0) {
    const err = new Error(`git merge-base ${baseCommit} ${head} failed: ${mergeBaseResult.stderr}`);
    (err as Error & { exitCode?: number }).exitCode = 7;
    throw err;
  }
  const mergeBase = mergeBaseResult.stdout.trim();

  // Check execution acknowledgment for cmd checks
  const hasCmd = task.checks.some(c => c.type === 'cmd');
  if (hasCmd && !opts.yes && !policy.execution.acknowledged) {
    const err = new Error(`task has cmd checks — re-run with --yes or set execution.acknowledged: true in .baton/policy.yml (G21 untrusted code execution)`);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // Try to read report from head (may not exist)
  const reportMatch = await fileExistsAtRef(repoRoot, head, `project-memory/reports/R-${taskId.split('-')[1]}.md`);
  let report: { changed_files: string[]; head_commit: string } | null = null;
  if (reportMatch) {
    try {
      const reportText = await readFileAtRef(repoRoot, head, `project-memory/reports/R-${taskId.split('-')[1]}.md`);
      const { frontMatter: reportFm } = parseFrontMatter(reportText);
      const parsed = ReportSchema.parse(reportFm);
      report = { changed_files: parsed.changed_files, head_commit: parsed.head_commit };
    } catch { /* malformed report — treat as missing */ }
  }

  // Allocate run ID under lock
  const runId = await withLock(repoRoot, async () => nextRunId(repoRoot));

  // Create worktree (P0-9)
  const wtPath = await createWorktree(repoRoot, taskId, runId, head);

  let results: CheckResult[];
  try {
    const ctx = {
      repoRoot,
      worktreePath: wtPath,
      baseCommit: mergeBase,      // v1.2 §6.4: diff from merge-base, not base tip
      baseTip: baseCommit,         // kept for the verify_run event (P0-4)
      headCommit: head,
      taskTouches: task.touches,
      policy,
      report,
      runId,
      taskId,
    };
    // v1.3.1: protected paths — a worker cannot weaken the tests it is judged by.
    // Must run BEFORE checks so cmd/grep/etc. see the locked merge-base versions.
    const protectedOutcome = await enforceProtectedPaths(ctx, task.allow_protected === true);
    results = await runAllChecks(ctx, task.checks);
    if (protectedOutcome.row) results.push(protectedOutcome.row);
  } finally {
    await removeWorktree(repoRoot, wtPath);
  }

  // Compute verdict
  const v = verdict(results);

  // For each claim with key K: find covering checks. If empty leave reported,
  // if all pass → verified, else → failed.
  const state = replay(events);
  const taskClaims = Array.from(state.claims.entries())
    .filter(([, c]) => c.taskId === taskId);

  const claimStatuses: { id: string; statement: string; key?: string; status: 'verified' | 'failed' | 'reported' }[] = [];
  for (const [id, c] of taskClaims) {
    if (!c.key) {
      claimStatuses.push({ id, statement: c.statement, key: undefined, status: 'reported' });
      continue;
    }
    const claimKey: string = c.key;
    // Find covering checks
    const coveringChecks = task.checks.filter(ch => 'covers' in ch && ch.covers?.includes(claimKey));
    if (coveringChecks.length === 0) {
      claimStatuses.push({ id, statement: c.statement, key: c.key, status: 'reported' });
      continue;
    }
    // Check if all covering checks passed
    const allPassed = coveringChecks.every(ch => {
      const r = results.find(res => res.id === ch.id);
      return r?.result === 'pass';
    });
    claimStatuses.push({
      id, statement: c.statement, key: c.key,
      status: allPassed ? 'verified' : 'failed',
    });
  }

  // Append ledger events under lock
  await withLock(repoRoot, async () => {
    const verifyRunId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: verifyRunId, ts: nowIso(),
      type: 'verify_run',
      run_id: runId,
      task: taskId,
      base_commit: baseCommit,    // P0-4: base branch tip at verify time (NOT merge-base)
      head_commit: head,
      verdict: v,
    });

    // Append check_result events
    for (const r of results) {
      const crId = await nextEventId(repoRoot);
      const event: LedgerEvent = {
        v: 1, id: crId, ts: nowIso(),
        type: 'check_result',
        run_id: runId,
        task: taskId,
        check: r.id,
        result: r.result,
        reason: r.reason,
        anchor: r.anchor,
        log: r.log,  // v1.2 §6.7: {path, sha256} for run logs
      };
      await appendLedger(repoRoot, event);
    }

    // Append claim_status events (verified or failed only — reported is implicit)
    for (const c of claimStatuses) {
      if (c.status === 'reported') continue;
      const csId = await nextEventId(repoRoot);
      const anchor = c.status === 'verified'
        ? { commit: head, watch: task.touches }
        : undefined;
      const event: LedgerEvent = {
        v: 1, id: csId, ts: nowIso(),
        type: 'claim_status',
        claim_id: c.id,
        status: c.status,
        anchor,
        reason: c.status === 'verified' ? 'all covering checks passed' : 'one or more covering checks failed',
        run_id: runId,    // P0-6
      };
      await appendLedger(repoRoot, event);
    }
  });

  return {
    taskId, runId, baseCommit, headCommit: head, branch,
    results, verdict: v, claims: claimStatuses,
  };
}

function policy_default_branch(_repoRoot: string): string {
  return 'main';  // simplified — full implementation reads policy first
}

/**
 * Format verify result as a verdict table. Spec §6.4 / §14.5.
 * P0-13: strength shown alongside check id.
 * Claims table BEFORE checks table (reviewer §14.5).
 */
export function formatVerdictTable(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`${result.taskId} · verify run ${result.runId}`);
  lines.push(`Branch: ${result.branch ?? '(detached)'} · Base: ${result.baseCommit.slice(0, 12)} · Head: ${result.headCommit.slice(0, 12)}`);
  lines.push('');

  // Claims table first
  if (result.claims.length > 0) {
    lines.push('CLAIM                                    STATUS');
    for (const c of result.claims) {
      const stmt = c.statement.length > 38 ? c.statement.slice(0, 35) + '...' : c.statement;
      const status = c.status.toUpperCase().padEnd(8);
      lines.push(`${stmt.padEnd(40)} ${status}`);
    }
    lines.push('');
  }

  // Checks table — failed first, then pass, then skip
  const sorted = [...result.results].sort((a, b) => {
    const order = { fail: 0, skip: 1, pass: 2 };
    return (order[a.result] ?? 3) - (order[b.result] ?? 3);
  });
  lines.push('CHECK                  TYPE         STRENGTH    RESULT');
  for (const r of sorted) {
    const strength = strengthOf(r.type);
    const id = r.id.length > 20 ? r.id.slice(0, 17) + '...' : r.id;
    const type = r.type.length > 12 ? r.type.slice(0, 9) + '...' : r.type;
    const result = r.result.toUpperCase();
    lines.push(`${id.padEnd(22)} ${type.padEnd(12)} ${strength.padEnd(11)} ${result}`);
    if (r.reason) {
      // v1.2 §6.7: print reason (includes last 20 lines for cmd failures)
      const reasonLines = r.reason.split('\n');
      for (let i = 0; i < reasonLines.length; i++) {
        const rl = reasonLines[i] ?? '';
        const truncated = rl.length > 100 ? rl.slice(0, 97) + '...' : rl;
        lines.push(`  ${i === 0 ? '└─' : '  '} ${truncated}`);
      }
    }
    if (r.log) {
      lines.push(`  └─ log: ${r.log.path}`);
    }
  }
  lines.push('');

  // Verdict
  const v = result.verdict.toUpperCase();
  lines.push(`Verdict: ${v}`);

  // Next action hint (reviewer §14.5)
  if (result.verdict === 'all_pass') {
    lines.push(`Next: baton accept ${result.taskId}`);
  } else if (result.verdict === 'has_failures') {
    lines.push(`Next: fix and re-verify, or baton reject ${result.taskId} --reason "..."`);
  } else {
    lines.push(`Next: re-run with --yes to acknowledge cmd checks`);
  }

  return lines.join('\n');
}
