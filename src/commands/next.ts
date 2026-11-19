// baton next — deterministic scheduler (v1.3 orchestrator core).
// Picks the highest-priority READY task a worker can start right now:
//   - dependencies must all be done (accepted)
//   - its touches must not overlap any in-flight task (assigned / in_review / needs_work)
// No AI: the orchestrator is another producer of ledger-derived decisions.
// Ordering is fully deterministic: task ID ascending (oldest first).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { readLedger } from '../io/ledger-file.js';
import { replay } from '../core/ledger-replay.js';
import { overlaps } from '../core/globs.js';

const IN_FLIGHT = new Set(['assigned', 'in_review', 'needs_work']);

export interface NextCandidate {
  id: string;
  title: string;
  status: string;
  touches: string[];
  dependsOn: string[];
}

export interface NextResult {
  pick: NextCandidate | null;
  queue: NextCandidate[];
  inFlight: { id: string; title: string; status: string; touches: string[] }[];
  blockedByDeps: { id: string; unmet: string[] }[];
  blockedByConflict: { id: string; overlappingWith: string[] }[];
}

interface TaskFileMeta {
  id: string;
  title: string;
  touches: string[];
  dependsOn: string[];
}

function parseFrontMatter(text: string): Record<string, unknown> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return (yaml.parse(m[1] ?? '') ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadTaskFiles(repoRoot: string): Promise<Map<string, TaskFileMeta>> {
  const dir = path.join(repoRoot, 'project-memory/tasks');
  const out = new Map<string, TaskFileMeta>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of files.filter(f => /^T-\d{4}\.md$/.test(f))) {
    try {
      const text = await readFile(path.join(dir, f), 'utf8');
      const fm = parseFrontMatter(text);
      if (!fm) continue;
      const id = String(fm.id ?? f.replace(/\.md$/, ''));
      out.set(id, {
        id,
        title: String(fm.title ?? '(untitled)'),
        touches: Array.isArray(fm.touches) ? (fm.touches as string[]) : [],
        dependsOn: Array.isArray(fm.depends_on) ? (fm.depends_on as string[]) : [],
      });
    } catch {
      // unreadable task file — doctor will flag it; scheduler skips
    }
  }
  return out;
}

export async function next(repoRoot: string): Promise<NextResult> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  const files = await loadTaskFiles(repoRoot);

  // In-flight tasks reserve their areas.
  const inFlight: { id: string; title: string; status: string; touches: string[] }[] = [];
  for (const [id, t] of state.tasks) {
    if (IN_FLIGHT.has(t.status)) {
      const meta = files.get(id);
      inFlight.push({ id, title: meta?.title ?? '(untitled)', status: t.status, touches: meta?.touches ?? [] });
    }
  }

  const result: NextResult = {
    pick: null,
    queue: [],
    inFlight,
    blockedByDeps: [],
    blockedByConflict: [],
  };

  for (const [id, t] of state.tasks) {
    if (t.status !== 'ready') continue;
    const meta = files.get(id);
    const touches = meta?.touches ?? [];
    const dependsOn = meta?.dependsOn ?? [];

    const unmet = dependsOn.filter(d => state.tasks.get(d)?.status !== 'done');
    if (unmet.length > 0) {
      result.blockedByDeps.push({ id, unmet });
      continue;
    }

    const overlapping = inFlight.filter(f => touches.some(touch => f.touches.some(of => overlaps(touch, of))));
    if (overlapping.length > 0) {
      result.blockedByConflict.push({ id, overlappingWith: overlapping.map(o => o.id) });
      continue;
    }

    result.queue.push({
      id,
      title: meta?.title ?? '(untitled)',
      status: t.status,
      touches,
      dependsOn,
    });
  }

  result.queue.sort((a, b) => a.id.localeCompare(b.id));
  result.pick = result.queue[0] ?? null;
  return result;
}

export function formatNextOutput(r: NextResult): string {
  const lines: string[] = [];
  if (r.pick) {
    lines.push(`NEXT: ${r.pick.id}  ${r.pick.title}`);
    lines.push(`  touches: ${r.pick.touches.join(', ') || '(none)'}`);
    if (r.pick.dependsOn.length > 0) lines.push(`  depends: ${r.pick.dependsOn.join(', ')}`);
    lines.push('');
    lines.push('Issue the work packet, then hand it to a worker:');
    lines.push(`  baton packet ${r.pick.id}`);
  } else {
    lines.push('No eligible task right now.');
  }

  if (r.queue.length > 1) {
    lines.push('');
    lines.push(`Queue (${r.queue.length} eligible):`);
    for (const c of r.queue.slice(1, 6)) lines.push(`  ${c.id}  ${c.title}`);
    if (r.queue.length > 6) lines.push(`  ... and ${r.queue.length - 6} more`);
  }
  if (r.inFlight.length > 0) {
    lines.push('');
    lines.push('In flight:');
    for (const f of r.inFlight) lines.push(`  ${f.id}  ${f.status.padEnd(10)}  ${f.title}`);
  }
  if (r.blockedByDeps.length > 0) {
    lines.push('');
    lines.push('Waiting on dependencies:');
    for (const b of r.blockedByDeps) lines.push(`  ${b.id}  needs: ${b.unmet.join(', ')}`);
  }
  if (r.blockedByConflict.length > 0) {
    lines.push('');
    lines.push('Waiting on area conflicts:');
    for (const b of r.blockedByConflict) lines.push(`  ${b.id}  overlaps: ${b.overlappingWith.join(', ')}`);
  }
  return lines.join('\n');
}
