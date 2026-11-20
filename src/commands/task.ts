// baton task command. Spec §5.4 + §6.3.
// baton task new "<title>" [--touches "<globs>"] [--depends <T-id>] — creates a draft task
// baton task ready <T-id> — locks the task (writes task_locked event with hash + base_commit)
// baton task list [--status <s>] — lists tasks with derived status
// baton task show <T-id> — prints task file
// baton task lint <T-id> — checks for check strength (P0-13)
// baton task block <T-id> --reason "<text>" — blocks task (P0-2: stores prior_status)
// baton task unblock <T-id> --reason "<text>" — restores to prior_status
// baton task unlock <T-id> --reason "<text>" — returns to draft (for re-ready)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { TaskSchema, type Task, type Check } from '../core/schemas.js';
import { commandAllowed } from '../core/check-engine.js';
import { withLock } from '../io/lock.js';
import { sha256Sync } from '../io/hash.js';
import { appendLedger, readLedger, nextEventId } from '../io/ledger-file.js';
import { fileExistsAtRef, getCommitSha } from '../io/git.js';
import { taskTemplate } from '../templates/index.js';
import { strengthOf } from '../core/verdicts.js';
import { replay } from '../core/ledger-replay.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Add commands to the allowed_commands list in policy.yml text.
 * Preserves existing formatting and comments.
 */
function addCommandsToPolicy(policyText: string, commands: string[]): string {
  const lines = policyText.split('\n');
  const idx = lines.findIndex(l => l.match(/^allowed_commands:\s*\[\s*\]/) || l.match(/^allowed_commands:\s*$/));
  if (idx === -1) {
    // No allowed_commands line — append one
    return policyText + `\nallowed_commands:\n${commands.map(c => `  - "${c}"`).join('\n')}\n`;
  }
  const line = lines[idx]!;
  if (line.includes('[]')) {
    // Replace `allowed_commands: []` with a list
    lines[idx] = 'allowed_commands:';
    const entries = commands.map(c => `  - "${c}"`);
    lines.splice(idx + 1, 0, ...entries);
  } else {
    // Already a list — append entries after the last existing entry
    let insertAt = idx + 1;
    while (insertAt < lines.length && lines[insertAt]?.startsWith('  - ')) {
      insertAt++;
    }
    const entries = commands.map(c => `  - "${c}"`);
    lines.splice(insertAt, 0, ...entries);
  }
  return lines.join('\n');
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
  const dir = path.join(repoRoot, 'project-memory/tasks');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter(f => /^T-\d{4}\.md$/.test(f))
    .map(f => f.replace(/\.md$/, ''));
}

export interface TaskNewOpts {
  title: string;
  touches: string[];
  depends?: string[];
  allowProtected?: boolean;
}

export async function taskNew(repoRoot: string, opts: TaskNewOpts): Promise<string> {
  return withLock(repoRoot, async () => {
    const existing = await listTaskIds(repoRoot);
    const nums = existing.map(s => parseInt(s.split('-')[1] ?? '0', 10)).filter(n => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const id = `T-${String(next).padStart(4, '0')}`;

    const content = taskTemplate(id, opts.title, opts.touches);
    // Add depends_on if provided
    let fm: Record<string, unknown> = {
      baton_version: 1,
      id,
      title: opts.title,
      touches: opts.touches,
      reads: [],
      decisions: [],
      non_goals: [],
      checks: [
        { id: 'scope', type: 'diff_scope', allow: opts.touches, description: `only ${opts.touches.join(', ')} may change` },
        { id: 'secrets', type: 'no_secrets' },
      ],
    };
    if (opts.depends && opts.depends.length > 0) {
      fm.depends_on = opts.depends;
    }
    if (opts.allowProtected) {
      fm.allow_protected = true;
    }
    // Validate
    TaskSchema.parse(fm);

    const filePath = path.join(repoRoot, 'project-memory/tasks', `${id}.md`);
    const body = '\n## Objective\n\n## Definition of done\n';
    const finalText = stringifyFrontMatter(fm, body);
    await writeFile(filePath, finalText, 'utf8');

    return id;
  });
}

export interface TaskReadyResult {
  taskId: string;
  hash: string;
  baseCommit: string;
  warnings: string[];
}

export async function taskReady(
  repoRoot: string,
  taskId: string,
  baseBranch = 'main',
  opts: { allowBranch?: boolean; allowWeak?: string; addAllowlist?: boolean } = {},
): Promise<TaskReadyResult> {
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const filePath = path.join(repoRoot, 'project-memory/tasks', `${taskId}.md`);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      const err = new Error(`task not found: ${taskId}`);
      (err as Error & { exitCode?: number }).exitCode = 3;
      throw err;
    }
    const { frontMatter } = parseFrontMatter(text);
    const task = TaskSchema.parse(frontMatter);

    // P1 (v1.2 §6): touches/reads globs must be POSIX. Reject backslashes at ready time.
    const backslashGlobs = [...(task.touches ?? []), ...(task.reads ?? [])].filter(g => g.includes('\\'));
    if (backslashGlobs.length > 0) {
      const err = new Error(
        `touches/reads globs must use POSIX forward slashes (backslashes found: ${backslashGlobs.join(', ')}). ` +
        'Edit the task file, commit, then run baton task ready again.'
      );
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    // Validate file exists on base branch (G17)
    const relPath = `project-memory/tasks/${taskId}.md`;
    const existsOnBase = await fileExistsAtRef(repoRoot, baseBranch, relPath);
    if (!existsOnBase) {
      const err = new Error(`task file ${taskId}.md is not committed on ${baseBranch}. Commit it before baton task ready.`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }

    // Validate depends_on tasks exist
    if (task.depends_on) {
      for (const dep of task.depends_on) {
        const depExists = await fileExistsAtRef(repoRoot, baseBranch, `project-memory/tasks/${dep}.md`);
        if (!depExists) {
          const err = new Error(`depends_on ${dep} not found on ${baseBranch}`);
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }
      }
    }

    // Validate reads files exist
    if (task.reads) {
      for (const r of task.reads) {
        const rExists = await fileExistsAtRef(repoRoot, baseBranch, r);
        if (!rExists) {
          const err = new Error(`reads file ${r} not found on ${baseBranch}`);
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }
      }
    }

    // Validate decisions exist and are accepted (if listed)
    // For Stage 1, just warn — full enforcement needs decision file reads

    // v1.2 §5.4: validate every cmd check is on the allowlist
    // Read policy from base branch (G17)
    const policyPath = path.join(repoRoot, '.baton/policy.yml');
    const policyText = await readFile(policyPath, 'utf8').catch(() => '');
    const policyRaw = yaml.parse(policyText) as { allowed_commands?: string[] } | null;
    const allowedCommands = policyRaw?.allowed_commands ?? [];
    const missingCommands: string[] = [];
    const arrayCmdEntries: string[] = [];  // derived allowlist entries for argv-array runs
    for (const check of task.checks) {
      if (check.type === 'cmd') {
        // v1.3.2 P2: allowlist matching on argv tokens (commandAllowed), same
        // engine as verify — string-prefix lookalikes ("nodemon x") can't pass.
        const argv = Array.isArray(check.run) ? [...check.run] : check.run.split(/\s+/).filter(Boolean);
        if (!commandAllowed(argv, allowedCommands)) {
          missingCommands.push(Array.isArray(check.run) ? JSON.stringify(check.run) : check.run);
          if (Array.isArray(check.run)) {
            // Conservative derived entry: first token + wildcard (owner can tighten).
            const entry = argv.length === 1 ? argv[0]! : argv[0]! + ' *';
            if (!arrayCmdEntries.includes(entry)) arrayCmdEntries.push(entry);
          }
        }
      }
    }
    if (missingCommands.length > 0) {
      if (opts.addAllowlist) {
        // Auto-add the missing commands to policy.yml. Array-form runs derive
        // a conservative "first token *" entry instead of their JSON label.
        const toAdd = missingCommands.map(cmd => {
          if (!cmd.startsWith('["')) return cmd;
          try {
            const argv = JSON.parse(cmd) as string[];
            return argv.length === 1 ? argv[0]! : argv[0]! + ' *';
          } catch { return cmd; }
        }).filter(cmd => !cmd.startsWith('["'));
        for (const e of arrayCmdEntries) if (!toAdd.includes(e)) toAdd.push(e);
        const updatedPolicyText = addCommandsToPolicy(policyText, toAdd);
        await writeFile(policyPath, updatedPolicyText, 'utf8');
        // Re-read to verify
        const verifyText = await readFile(policyPath, 'utf8');
        const verifyRaw = yaml.parse(verifyText) as { allowed_commands?: string[] } | null;
        const updatedAllowed = verifyRaw?.allowed_commands ?? [];
        const stillMissing = task.checks.filter((c): c is Extract<typeof c, { type: 'cmd' }> => c.type === 'cmd')
          .filter(c => {
            const argv = Array.isArray(c.run) ? [...c.run] : c.run.split(/\s+/).filter(Boolean);
            return !commandAllowed(argv, updatedAllowed);
          })
          .map(c => Array.isArray(c.run) ? JSON.stringify(c.run) : c.run);
        if (stillMissing.length > 0) {
          const err = new Error(
            `failed to add commands to policy.yml. Still missing: ${stillMissing.join(', ')}`
          );
          (err as Error & { exitCode?: number }).exitCode = 5;
          throw err;
        }
      } else {
        // Print the YAML block to paste, exit 5
        const yamlBlock = missingCommands.map(cmd => `  - "${cmd}"`).join('\n');
        const err = new Error(
          `cmd check(s) not on allowlist: ${missingCommands.join(', ')}\n` +
          `Add to .baton/policy.yml under allowed_commands:\n\nallowed_commands:\n${yamlBlock}\n\n` +
          `Or re-run with --add-allowlist to add them automatically.`
        );
        (err as Error & { exitCode?: number }).exitCode = 5;
        throw err;
      }
    }

    // Compute hash
    const hash = sha256Sync(text);
    const baseCommit = await getCommitSha(repoRoot, baseBranch);

    // Check if already locked with same hash (idempotent)
    const { events } = await readLedger(repoRoot);
    const existingLocked = events
      .filter(e => e.type === 'task_locked' && e.task === taskId)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    if (existingLocked.length > 0) {
      const lastLock = existingLocked[existingLocked.length - 1];
      if (lastLock && 'hash' in lastLock && lastLock.hash === hash) {
        // Already locked with same hash — idempotent, no new event
        return {
          taskId,
          hash,
          baseCommit,
          warnings: ['task already locked with same hash (idempotent)'],
        };
      }
    }

    // v1.2 §5.4: task ready BLOCKS (exit 4) when no behavior or interface check,
    // unless --allow-weak "<reason>" is provided.
    const warnings: string[] = [];
    const hasBehavior = task.checks.some(c => strengthOf(c.type) === 'behavior');
    const hasInterface = task.checks.some(c => strengthOf(c.type) === 'interface');
    if (!hasBehavior && !hasInterface) {
      if (!opts.allowWeak || opts.allowWeak.length === 0) {
        const err = new Error(
          `task ready blocked: no behavior (cmd) or interface (contract) check present. ` +
          `Claims will not be verifiable beyond hygiene. ` +
          `Override with --allow-weak "<reason>" (recorded in task_locked event).`
        );
        (err as Error & { exitCode?: number }).exitCode = 4;
        throw err;
      }
      // --allow-weak waives the error; record the reason as a warning
      warnings.push(`weak checks allowed: ${opts.allowWeak}`);
    }

    // Record task_locked event
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'task_locked',
      task: taskId,
      hash,
      base_commit: baseCommit,
      // v1.2 §5.4: --allow-weak reason recorded in the event
      ...(opts.allowWeak ? { allow_weak: opts.allowWeak } : {}),
    });

    return { taskId, hash, baseCommit, warnings };
  });
}

export async function taskList(repoRoot: string, statusFilter?: string): Promise<{ id: string; title: string; status: string }[]> {
  const ids = await listTaskIds(repoRoot);
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  const result: { id: string; title: string; status: string }[] = [];
  for (const id of ids) {
    const filePath = path.join(repoRoot, 'project-memory/tasks', `${id}.md`);
    let title = '';
    try {
      const text = await readFile(filePath, 'utf8');
      const { frontMatter } = parseFrontMatter(text);
      title = (frontMatter.title as string) ?? '';
    } catch { /* ignore */ }
    const taskState = state.tasks.get(id);
    const status = taskState?.status ?? 'draft';
    if (!statusFilter || status === statusFilter) {
      result.push({ id, title, status });
    }
  }
  return result;
}

export async function taskShow(repoRoot: string, taskId: string): Promise<string> {
  const filePath = path.join(repoRoot, 'project-memory/tasks', `${taskId}.md`);
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    const err = new Error(`task not found: ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }
}

export interface TaskLintResult {
  taskId: string;
  warnings: string[];
  checks: { id: string; type: string; strength: string }[];
}

export async function taskLint(repoRoot: string, taskId: string): Promise<TaskLintResult> {
  const filePath = path.join(repoRoot, 'project-memory/tasks', `${taskId}.md`);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    const err = new Error(`task not found: ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }
  const { frontMatter } = parseFrontMatter(text);
  const task = TaskSchema.parse(frontMatter);

  const warnings: string[] = [];
  const checks = task.checks.map(c => ({
    id: c.id,
    type: c.type,
    strength: strengthOf(c.type),
  }));

  const hasBehavior = task.checks.some(c => strengthOf(c.type) === 'behavior');
  const hasInterface = task.checks.some(c => strengthOf(c.type) === 'interface');
  if (!hasBehavior && !hasInterface) {
    warnings.push('no behavior (cmd) or interface (contract) check present');
  }
  if (task.checks.length < 2) {
    warnings.push('fewer than 2 checks — consider adding scope and no_secrets at minimum');
  }

  return { taskId, warnings, checks };
}

// P0-2: task block stores prior_status on the blocked event.
export async function taskBlock(
  repoRoot: string,
  taskId: string,
  reason: string,
  opts: { allowBranch?: boolean; baseBranch?: string } = {},
): Promise<{ taskId: string; priorStatus: string }> {
  if (!reason || reason.length === 0) {
    const err = new Error('block requires --reason');
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const { events } = await readLedger(repoRoot);
    const state = replay(events);
    const t = state.tasks.get(taskId);
    if (!t) {
      const err = new Error(`task ${taskId} not locked`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    const priorStatus = t.status;
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'blocked',
      task: taskId,
      prior_status: priorStatus,    // P0-2
      reason,
    });
    return { taskId, priorStatus };
  });
}

export async function taskUnblock(
  repoRoot: string,
  taskId: string,
  reason: string,
  opts: { allowBranch?: boolean; baseBranch?: string } = {},
): Promise<{ taskId: string; restoredStatus: string }> {
  if (!reason || reason.length === 0) {
    const err = new Error('unblock requires --reason');
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const { events } = await readLedger(repoRoot);
    const state = replay(events);
    const t = state.tasks.get(taskId);
    if (!t || t.status !== 'blocked') {
      const err = new Error(`task ${taskId} is not blocked`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    // P0-2: prior_status was stored on the most recent blocked event
    const restoredStatus = t.priorStatus ?? 'ready';  // fallback for legacy lines
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'unblocked',
      task: taskId,
      reason,
    });
    return { taskId, restoredStatus };
  });
}

// task unlock returns to draft for re-ready (e.g., checks changed)
export async function taskUnlock(
  repoRoot: string,
  taskId: string,
  reason: string,
  opts: { allowBranch?: boolean; baseBranch?: string } = {},
): Promise<{ taskId: string }> {
  if (!reason || reason.length === 0) {
    const err = new Error('unlock requires --reason');
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  return withLock(repoRoot, async () => {
    const { events } = await readLedger(repoRoot);
    const state = replay(events);
    const t = state.tasks.get(taskId);
    if (!t) {
      const err = new Error(`task ${taskId} not locked`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'task_unlocked',
      task: taskId,
      reason,
    });
    return { taskId };
  });
}
