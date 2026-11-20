// baton workers — worker reputation (v1.3 orchestrator core).
// Derives a reputation table from evidence already in the repo:
//   - report files carry `worker` (ReportSchema) → maps tasks to workers
//   - ledger carries the outcomes: accepted / rejected / verify failures
// Score = 10·accepted − 5·rejected − 1·verify_failures (deterministic, explainable).
// The orchestrator uses this to prefer reliable workers when dispatching (Stage 6).
// v1.3.2 P3: the worker identity is SELF-DECLARED (report front matter, not
// bound to a lease or ledger writer), so the output is explicitly labeled
// advisory.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { readLedger } from '../io/ledger-file.js';
import type { LedgerEvent } from '../core/schemas.js';

const REPORT_RE = /^R-\d{4}\.md$/;

export interface WorkerReputation {
  worker: string;
  accepted: number;
  rejected: number;
  verifyFailures: number;
  score: number;
  tasks: string[];
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

export async function workers(repoRoot: string): Promise<{ workers: WorkerReputation[] }> {
  const { events } = await readLedger(repoRoot);

  // Outcome per task from the ledger
  const acceptedTasks = new Set(
    events.filter((e): e is Extract<LedgerEvent, { type: 'accepted' }> => e.type === 'accepted').map(e => e.task),
  );
  const rejectedTasks = new Set(
    events.filter((e): e is Extract<LedgerEvent, { type: 'rejected' }> => e.type === 'rejected').map(e => e.task),
  );
  const failedVerifyTasks = new Set(
    events
      .filter((e): e is Extract<LedgerEvent, { type: 'verify_run' }> => e.type === 'verify_run' && e.verdict !== 'all_pass')
      .map(e => e.task),
  );

  // task → worker from report files
  const workerByTask = new Map<string, string>();
  let dir: string[] = [];
  try {
    dir = await readdir(path.join(repoRoot, 'project-memory/reports'));
  } catch { /* no reports yet */ }

  for (const f of dir.filter(f => REPORT_RE.test(f))) {
    try {
      const text = await readFile(path.join(repoRoot, 'project-memory/reports', f), 'utf8');
      const fm = parseFrontMatter(text);
      const task = typeof fm?.task === 'string' ? fm.task : '';
      const worker = typeof fm?.worker === 'string' ? fm.worker : '';
      if (task && worker && !workerByTask.has(task)) workerByTask.set(task, worker);
    } catch { /* skip unreadable */ }
  }

  // Aggregate per worker
  const byWorker = new Map<string, WorkerReputation>();
  const ensure = (worker: string): WorkerReputation => {
    let w = byWorker.get(worker);
    if (!w) {
      w = { worker, accepted: 0, rejected: 0, verifyFailures: 0, score: 0, tasks: [] };
      byWorker.set(worker, w);
    }
    return w;
  };

  for (const [task, worker] of workerByTask) {
    const w = ensure(worker);
    if (acceptedTasks.has(task)) w.accepted++;
    if (rejectedTasks.has(task)) w.rejected++;
    if (failedVerifyTasks.has(task)) w.verifyFailures++;
    w.tasks.push(task);
  }

  const list = Array.from(byWorker.values());
  for (const w of list) {
    w.score = w.accepted * 10 - w.rejected * 5 - w.verifyFailures;
    w.tasks.sort();
  }
  list.sort((a, b) => b.score - a.score || a.worker.localeCompare(b.worker));
  return { workers: list };
}

export function formatWorkersOutput(list: WorkerReputation[]): string {
  if (list.length === 0) {
    return 'No worker reputation yet. Reputation is derived from report front matter (`worker:`) joined with ledger outcomes.';
  }
  const lines = [
    'Worker reputation (score = 10·accepted − 5·rejected − 1·verify_failures):',
    'ADVISORY — worker names are self-declared in report front matter and are not',
    'bound to a lease or the ledger writer; treat rankings as a dispatch hint.',
    '',
  ];
  for (const w of list) {
    lines.push(`  ${w.worker.padEnd(20)} score ${String(w.score).padStart(5)}  accepted ${w.accepted}  rejected ${w.rejected}  verify_fails ${w.verifyFailures}  tasks: ${w.tasks.join(', ') || '(none)'}`);
  }
  return lines.join('\n');
}
