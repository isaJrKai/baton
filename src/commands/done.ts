// baton done — Definition of Done calculator (v1.3 orchestrator core).
// Answers one question mechanically: is this project complete?
// A project is DONE when ALL of the following hold:
//   1. every known task (ledger state or task file) has final status `done` (accepted)
//   2. no escalated tasks await human review
//   3. baton doctor reports zero structural errors
//   4. zero unresolved claim conflicts
// Exit 0 when done; exit 1 with the blocker list otherwise.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readLedger } from '../io/ledger-file.js';
import { replay } from '../core/ledger-replay.js';
import { doctor } from './doctor.js';

export interface DoneResult {
  done: boolean;
  pending: { id: string; title: string; status: string; escalated: boolean }[];
  escalated: string[];
  doctorErrors: { code: string; message: string }[];
  claimConflicts: number;
}

export async function done(repoRoot: string): Promise<DoneResult> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  // Known tasks = union of ledger tasks and task files on disk
  const known = new Set<string>(state.tasks.keys());
  try {
    const files = await readdir(path.join(repoRoot, 'project-memory/tasks'));
    for (const f of files) {
      if (/^T-\d{4}\.md$/.test(f)) known.add(f.replace(/\.md$/, ''));
    }
  } catch { /* no tasks dir — nothing pending from files */ }

  const pending: { id: string; title: string; status: string; escalated: boolean }[] = [];
  const escalated: string[] = [];
  for (const id of Array.from(known).sort()) {
    const t = state.tasks.get(id);
    const status = t?.status ?? 'draft'; // task file exists but never locked
    const isEscalated = t?.escalated ?? false;
    if (isEscalated) escalated.push(id);
    if (status !== 'done') {
      pending.push({ id, title: '(see task file)', status, escalated: isEscalated });
    }
  }

  // Structural integrity
  const doctorResult = await doctor(repoRoot);
  const doctorErrors = doctorResult.findings
    .filter(f => f.level === 'error')
    .map(f => ({ code: f.code, message: f.message }));

  // Claim conflicts
  const { findConflicts } = await import('../core/ledger-replay.js');
  const conflicts = findConflicts(events).claimConflicts.length;

  const done = pending.length === 0 && doctorErrors.length === 0 && conflicts === 0;
  return { done, pending, escalated, doctorErrors, claimConflicts: conflicts };
}

export function formatDoneOutput(r: DoneResult): string {
  if (r.done) {
    return [
      'PROJECT DONE.',
      '',
      'All tasks accepted, doctor clean, no unresolved claim conflicts.',
      'Definition of done is satisfied mechanically, not by report.',
    ].join('\n');
  }

  const lines: string[] = ['NOT DONE.', ''];

  if (r.pending.length > 0) {
    lines.push(`Pending tasks (${r.pending.length}):`);
    for (const p of r.pending) {
      const tag = p.escalated ? '  [ESCALATED]' : '';
      lines.push(`  ${p.id}  ${p.status.padEnd(12)}${tag}`);
    }
    lines.push('');
  }
  if (r.escalated.length > 0) {
    lines.push(`Escalated (2+ rejections, needs human decision): ${r.escalated.join(', ')}`);
    lines.push('');
  }
  if (r.doctorErrors.length > 0) {
    lines.push(`Structural errors (${r.doctorErrors.length}):`);
    for (const e of r.doctorErrors.slice(0, 8)) lines.push(`  ! ${e.code}: ${e.message}`);
    lines.push('');
  }
  if (r.claimConflicts > 0) {
    lines.push(`Unresolved claim conflicts: ${r.claimConflicts} (run: baton conflicts)`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
