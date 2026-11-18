// v1.3.0 — baton done: the computable definition of "the work is complete".
//
// This is the orchestrator's terminal signal. Completion is not a feeling, it
// is a checklist over the ledger and the repo:
//
//   G1. Every task file ends in status done (replayed from ledger).
//       Draft/ready/assigned/in_review/needs_work/blocked/rejected = fail.
//       A rejected task only passes if it carries a follow-up that is done.
//   G2. Zero stale verified claims (stale --dry-run equivalent).
//   G3. Zero unacknowledged conflicts (decision + claim conflicts).
//   G4. doctor reports zero errors (structural integrity).
//   G5. No decisions left in proposed state.
//   G6. project-memory/STATE.md exists and is within the 60-line budget
//       (warning-level in doctor; here it is a hard gate).
//
// Read-only: writes nothing to the ledger. Exit 0 = done, exit 1 = not done.
// --json for the orchestrator to consume programmatically.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { readLedger } from '../io/ledger-file.js';
import { replay } from '../core/ledger-replay.js';
import { doctor } from './doctor.js';
import { stale } from './stale.js';
import { conflicts } from './conflicts.js';

export interface DoneGate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface DoneResult {
  done: boolean;
  gates: DoneGate[];
}

function parseFrontMatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('front matter not found');
  return yaml.parse(m[1] ?? '') as Record<string, unknown>;
}

export async function done(repoRoot: string): Promise<DoneResult> {
  const gates: DoneGate[] = [];

  // ---- G1: all tasks done ----
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  // Enumerate task files (a task that was never locked is still draft — fail).
  let taskFiles: string[] = [];
  try {
    taskFiles = (await readdir(path.join(repoRoot, 'project-memory/tasks'))).filter(f => f.endsWith('.md'));
  } catch { taskFiles = []; }

  const offenders: string[] = [];
  for (const f of taskFiles) {
    const taskId = f.replace(/\.md$/, '');
    const t = state.tasks.get(taskId);
    if (!t) {
      offenders.push(`${taskId} (draft — never locked)`);
      continue;
    }
    if (t.status === 'done') continue;
    if (t.status === 'rejected' && t.followUpTask) {
      const fu = state.tasks.get(t.followUpTask);
      if (fu?.status === 'done') continue;
      offenders.push(`${taskId} (rejected, follow-up ${t.followUpTask} not done)`);
      continue;
    }
    offenders.push(`${taskId} (${t.status})`);
  }
  // Tasks known only to the ledger but whose file was deleted also fail.
  for (const [taskId, t] of state.tasks) {
    if (!taskFiles.includes(`${taskId}.md`)) {
      offenders.push(`${taskId} (${t.status}, task file missing)`);
    }
  }
  gates.push({
    id: 'G1',
    label: 'All tasks done',
    pass: offenders.length === 0 && taskFiles.length > 0,
    detail: offenders.length === 0
      ? `${taskFiles.length} task(s), all done`
      : offenders.join('; '),
  });

  // ---- G2: zero stale claims (dry-run) ----
  const staleResult = await stale(repoRoot, { dryRun: true });
  gates.push({
    id: 'G2',
    label: 'Zero stale verified claims',
    pass: staleResult.staleClaims.length === 0,
    detail: `${staleResult.totalChecked} checked, ${staleResult.staleClaims.length} stale`,
  });

  // ---- G3: zero unacknowledged conflicts ----
  const conflictResult = await conflicts(repoRoot, {});
  const unresolved = [
    ...conflictResult.decisionConflicts.filter(c => !c.acknowledged),
    ...conflictResult.claimConflicts.filter(c => !c.acknowledged),
  ];
  gates.push({
    id: 'G3',
    label: 'Zero unacknowledged conflicts',
    pass: unresolved.length === 0,
    detail: unresolved.length === 0
      ? 'no conflicts'
      : unresolved.map(c => (c as { key: string }).key).join(', '),
  });

  // ---- G4: doctor clean (errors only) ----
  const doctorResult = await doctor(repoRoot);
  const doctorErrors = doctorResult.findings.filter(f => f.level === 'error');
  gates.push({
    id: 'G4',
    label: 'doctor reports no errors',
    pass: !doctorResult.hasErrors,
    detail: doctorErrors.length === 0
      ? `${doctorResult.findings.filter(f => f.level === 'warning').length} warning(s)`
      : doctorErrors.map(e => `${e.code}: ${e.message}`).join('; ').slice(0, 300),
  });

  // ---- G5: no proposed decisions ----
  let decisionFiles: string[] = [];
  try {
    decisionFiles = (await readdir(path.join(repoRoot, 'project-memory/decisions'))).filter(f => f.endsWith('.md'));
  } catch { decisionFiles = []; }
  const proposed: string[] = [];
  for (const f of decisionFiles) {
    try {
      const text = await readFile(path.join(repoRoot, 'project-memory/decisions', f), 'utf8');
      const fm = parseFrontMatter(text);
      if (fm.status === 'proposed') proposed.push(String(fm.id ?? f));
    } catch { /* malformed handled by doctor */ }
  }
  gates.push({
    id: 'G5',
    label: 'No decisions left proposed',
    pass: proposed.length === 0,
    detail: proposed.length === 0 ? `${decisionFiles.length} decision(s) resolved` : proposed.join(', '),
  });

  // ---- G6: STATE.md present and within budget ----
  let stateMd = '';
  try {
    stateMd = await readFile(path.join(repoRoot, 'project-memory/STATE.md'), 'utf8');
  } catch { /* missing */ }
  const stateLines = stateMd ? stateMd.split('\n').length : 0;
  gates.push({
    id: 'G6',
    label: 'STATE.md present and <= 60 lines',
    pass: stateLines > 0 && stateLines <= 60,
    detail: stateLines === 0 ? 'STATE.md missing' : `${stateLines} lines`,
  });

  return { done: gates.every(g => g.pass), gates };
}

export function formatDoneOutput(result: DoneResult): string {
  const lines: string[] = [];
  lines.push(result.done ? 'BATON: DONE' : 'BATON: NOT DONE');
  lines.push('');
  for (const g of result.gates) {
    lines.push(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.id} ${g.label}`);
    lines.push(`         ${g.detail}`);
  }
  if (!result.done) {
    lines.push('');
    lines.push('Complete the failing gates, then re-run baton done.');
  }
  return lines.join('\n');
}
