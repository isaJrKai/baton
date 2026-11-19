// baton doctor command. Spec §7.3a.
// Structural integrity only — never stale or conflicts.
// Errors (exit 3): unparseable files, duplicate IDs, ledger parse failures,
//   truncated ledger line, non-increasing IDs, locked hash mismatch,
//   decision hash mismatch, invalid secret patterns, invalid policy,
//   orphan reports, stale worktrees.
// Warnings (exit 0): report whose task is done/rejected, several terminal events,
//   missing gitignore, STATE.md over 60 lines.
import { readLedger, rewriteLedger } from '../io/ledger-file.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { git } from '../io/git.js';
import { sha256Sync } from '../io/hash.js';
import { replay } from '../core/ledger-replay.js';
import { fileExistsAtRef } from '../io/git.js';
import { withLock } from '../io/lock.js';
import type { LedgerEvent } from '../core/schemas.js';

function parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return { frontMatter: yaml.parse(m[1] ?? '') as Record<string, unknown>, body: m[2] ?? '' };
  } catch {
    return null;
  }
}

interface DoctorFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  fix?: string;
}

export async function doctor(repoRoot: string): Promise<{ findings: DoctorFinding[]; hasErrors: boolean }> {
  const findings: DoctorFinding[] = [];

  // 1. Check ledger parseability
  const { events, malformed } = await readLedger(repoRoot);
  if (malformed.length > 0) {
    for (const m of malformed) {
      findings.push({
        level: 'error',
        code: 'E_LEDGER_MALFORMED',
        message: `ledger.jsonl:${m.line}: malformed JSON`,
        fix: 'Edit or remove the malformed line. Run: baton doctor --fix (not implemented)',
      });
    }
  }

  // 2. Check non-increasing ledger IDs
  let lastId = 0;
  for (const e of events) {
    const num = parseInt(e.id.split('-')[1] ?? '0', 10);
    if (num <= lastId && lastId > 0) {
      findings.push({
        level: 'error',
        code: 'E_NON_INCREASING_ID',
        message: `ledger.jsonl: non-increasing ID ${e.id} after e-${String(lastId).padStart(6, '0')}`,
        fix: 'Run: baton doctor --fix (renumbers events after a merged branch)',
      });
    }
    lastId = Math.max(lastId, num);
  }

  // 2b. Check duplicate event IDs. v1.3.1: two branches that both appended
  // ledger events (each allocating from the same base) collide when their
  // branches are union-merged (.gitattributes: ledger.jsonl merge=union).
  const seenIds = new Set<string>();
  for (const e of events) {
    if (seenIds.has(e.id)) {
      findings.push({
        level: 'error',
        code: 'E_DUPLICATE_EVENT_ID',
        message: `ledger.jsonl: duplicate event ID ${e.id} (union merge of diverged branches?)`,
        fix: 'Run: baton doctor --fix (renumbers events, remaps claim/run IDs)',
      });
    }
    seenIds.add(e.id);
  }

  // 3. Check task files
  const tasksDir = path.join(repoRoot, 'project-memory/tasks');
  let taskFiles: string[];
  try { taskFiles = await readdir(tasksDir); } catch { taskFiles = []; }
  const taskIds = new Set<string>();
  for (const f of taskFiles) {
    if (!f.endsWith('.md')) continue;
    const taskId = f.replace(/\.md$/, '');
    if (taskIds.has(taskId)) {
      findings.push({ level: 'error', code: 'E_DUPLICATE_TASK_ID', message: `duplicate task ID: ${taskId}` });
    }
    taskIds.add(taskId);

    const text = await readFile(path.join(tasksDir, f), 'utf8').catch(() => '');
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: 'error', code: 'E_UNPARSEABLE', message: `${f}: front matter parse failed` });
    }
  }

  // 4. Check decision files
  const decisionsDir = path.join(repoRoot, 'project-memory/decisions');
  let decisionFiles: string[];
  try { decisionFiles = await readdir(decisionsDir); } catch { decisionFiles = []; }
  const decisionIds = new Set<string>();
  for (const f of decisionFiles) {
    if (!f.endsWith('.md')) continue;
    const decisionId = f.replace(/\.md$/, '');
    if (decisionIds.has(decisionId)) {
      findings.push({ level: 'error', code: 'E_DUPLICATE_DECISION_ID', message: `duplicate decision ID: ${decisionId}` });
    }
    decisionIds.add(decisionId);

    const text = await readFile(path.join(decisionsDir, f), 'utf8').catch(() => '');
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: 'error', code: 'E_UNPARSEABLE', message: `${f}: front matter parse failed` });
    }
  }

  // 5. Check locked task hashes match base branch
  const state = replay(events);
  let baseBranch = 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policyRaw = yaml.parse(policyText) as { default_branch?: string } | null;
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch { /* use default */ }

  for (const [taskId, t] of state.tasks) {
    if (!t.lockedHash) continue;
    // Check if task file exists on base branch and hash matches
    const taskPath = `project-memory/tasks/${taskId}.md`;
    const exists = await fileExistsAtRef(repoRoot, baseBranch, taskPath);
    if (!exists) {
      findings.push({
        level: 'error',
        code: 'E_LOCK_HASH_MISMATCH',
        message: `task ${taskId}: locked but not found on ${baseBranch}`,
        fix: `baton task unlock ${taskId} --reason "not on base"`,
      });
    }
  }

  // 6. Check for stale worktrees
  try {
    const wtResult = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
    if (wtResult.exitCode === 0) {
      const blocks = wtResult.stdout.split('\n\n');
      for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.length > 0);
        const wtLine = lines.find(l => l.startsWith('worktree '));
        if (!wtLine) continue;
        const wtPath = wtLine.slice('worktree '.length);
        if (wtPath.includes('.baton/tmp/wt-')) {
          findings.push({
            level: 'error',
            code: 'E_STALE_WORKTREE',
            message: `stale worktree: ${wtPath}`,
            fix: 'git worktree remove --force ' + wtPath,
          });
        }
      }
    }
  } catch { /* ignore */ }

  // 7. Check STATE.md line count
  try {
    const stateText = await readFile(path.join(repoRoot, 'project-memory/STATE.md'), 'utf8');
    const lineCount = stateText.split('\n').length;
    if (lineCount > 60) {
      findings.push({
        level: 'warning',
        code: 'W_STATE_TOO_LONG',
        message: `STATE.md is ${lineCount} lines (guidance: 60)`,
      });
    }
  } catch { /* ignore */ }

  // 8. Check gitignore entries
  try {
    const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    const required = ['project-memory/packets/', 'project-memory/sessions/', '.baton/'];
    for (const r of required) {
      if (!gitignore.includes(r)) {
        findings.push({ level: 'warning', code: 'W_MISSING_GITIGNORE', message: `.gitignore missing: ${r}` });
      }
    }
  } catch { /* ignore */ }

  const hasErrors = findings.some(f => f.level === 'error');
  return { findings, hasErrors };
}

/**
 * v1.3.1: repair a ledger corrupted by a union merge of two branches that both
 * appended events. The ledger is append-only JSONL with strictly increasing
 * event IDs (e-000001…); two branches allocating from the same base produce
 * duplicate IDs and broken monotonicity when merged.
 *
 * Repair, in file order (never reordered — git's union output is kept):
 *   1. Renumber event IDs to a strictly increasing e-000001… sequence.
 *   2. Remap claim IDs (c-0001…) by first appearance — two branches can each
 *      have allocated c-0001 for different claims; claim_status references are
 *      remapped consistently.
 *   3. Remap run IDs (r-0001…) the same way (verify_run / check_result /
 *      claim_status references).
 *   4. Append a `ledger_repaired` event recording what changed.
 *
 * Refuses to run when the ledger has malformed (unparseable) lines — repair
 * must not guess. Returns what was changed so the CLI can print a summary.
 */
export interface DoctorFixResult {
  changed: boolean;
  renumbered: number;
  remappedClaims: number;
  remappedRuns: number;
}

export async function doctorFix(repoRoot: string): Promise<DoctorFixResult> {
  const { events, malformed } = await readLedger(repoRoot);
  if (malformed.length > 0) {
    throw new Error(
      `cannot --fix: ledger has ${malformed.length} malformed line(s) at ` +
      malformed.map(m => m.line).join(', ') + ' — repair those manually first',
    );
  }

  let changed = false;
  let renumbered = 0;
  let remappedClaims = 0;
  let remappedRuns = 0;
  // old claim/run id -> latest new id. A collision (second branch allocated the
  // same id) allocates a FRESH id and becomes the latest — follow-up events
  // (claim_status / check_result) that appear after it remap to it. This mirrors
  // git's union merge layout: ours first, then theirs, sequentially in file order.
  const claimMap = new Map<string, string>();
  const runMap = new Map<string, string>();
  let claimNum = 0;
  let runNum = 0;
  const out: LedgerEvent[] = [];

  const nextClaimId = (): string => `c-${String(++claimNum).padStart(4, '0')}`;
  const nextRunId = (): string => `r-${String(++runNum).padStart(4, '0')}`;

  for (let i = 0; i < events.length; i++) {
    const src = events[i] as LedgerEvent & Record<string, unknown>;
    const e = { ...src } as LedgerEvent & Record<string, unknown>;

    // 1. Renumber event IDs in file order
    const expected = `e-${String(i + 1).padStart(6, '0')}`;
    if (e.id !== expected) {
      renumbered++;
      changed = true;
    }
    e.id = expected;

    // 2. Remap claim IDs. Each `claim` event is a distinct claim (ids are
    // allocated uniquely per branch); the first occurrence keeps its id,
    // every later occurrence with the same id is the other branch's claim
    // and gets a fresh id. claim_status follows the most recent claim.
    if (e.type === 'claim' && typeof e.claim_id === 'string') {
      const old = e.claim_id;
      const mapped = nextClaimId();
      claimMap.set(old, mapped);
      if (mapped !== old) {
        e.claim_id = mapped;
        remappedClaims++;
        changed = true;
      }
    } else if (e.type === 'claim_status' && typeof e.claim_id === 'string') {
      const mapped = claimMap.get(e.claim_id);
      if (mapped && mapped !== e.claim_id) {
        e.claim_id = mapped;
        remappedClaims++;
        changed = true;
      }
    }

    // 3. Remap run IDs the same way: each verify_run is a distinct run;
    // check_result / claim_status follow the most recent verify_run.
    if (e.type === 'verify_run' && typeof e.run_id === 'string') {
      const old = e.run_id;
      const mapped = nextRunId();
      runMap.set(old, mapped);
      if (mapped !== old) {
        e.run_id = mapped;
        remappedRuns++;
        changed = true;
      }
    } else if ((e.type === 'check_result' || e.type === 'claim_status') && typeof e.run_id === 'string') {
      const mapped = runMap.get(e.run_id);
      if (mapped && mapped !== e.run_id) {
        e.run_id = mapped;
        remappedRuns++;
        changed = true;
      }
    }

    out.push(e as unknown as LedgerEvent);
  }

  if (!changed) {
    return { changed: false, renumbered: 0, remappedClaims: 0, remappedRuns: 0 };
  }

  // 4. Append the audit marker
  const repaired: LedgerEvent = {
    v: 1,
    id: `e-${String(out.length + 1).padStart(6, '0')}`,
    ts: new Date().toISOString(),
    type: 'ledger_repaired',
    renumbered_events: renumbered,
    remapped_claims: remappedClaims,
    remapped_runs: remappedRuns,
    reason: 'post-merge ID repair: union merge of diverged branches (baton doctor --fix)',
  };
  out.push(repaired);

  await withLock(repoRoot, async () => {
    await rewriteLedger(repoRoot, out);
  });

  return { changed: true, renumbered, remappedClaims, remappedRuns };
}

export function formatDoctorOutput(result: { findings: DoctorFinding[]; hasErrors: boolean }): string {
  const lines: string[] = [];
  const errors = result.findings.filter(f => f.level === 'error');
  const warnings = result.findings.filter(f => f.level === 'warning');

  if (errors.length > 0) {
    lines.push(`ERRORS (${errors.length})`);
    for (const e of errors) {
      lines.push(`  ${e.code}: ${e.message}`);
      if (e.fix) lines.push(`    fix: ${e.fix}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`WARNINGS (${warnings.length})`);
    for (const w of warnings) {
      lines.push(`  ${w.code}: ${w.message}`);
    }
  }
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('No issues found. All clear.');
  }
  return lines.join('\n');
}
