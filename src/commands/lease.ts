// v1.3.0 — baton lease: area leases for deterministic multi-worker dispatch.
//
// The orchestrator's job is scheduling, not judgment. Leases are the
// scheduling primitive: a worker (or the orchestrator on its behalf) takes an
// exclusive lease on a task's touches areas before work begins. The ledger
// records lease_acquired / lease_released; replay recomputes expiry from
// timestamps, so leases survive restarts and are auditable like every other
// event.
//
// Overlap rule: two tasks conflict if their touches globs overlap per
// core/globs.ts static-prefix semantics (same rule the packet compiler uses
// for decision areas). A lease may NOT be taken while another task holds an
// overlapping ACTIVE lease.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { TaskSchema } from '../core/schemas.js';
import { readLedger, appendLedger, nextEventId } from '../io/ledger-file.js';
import { withLock } from '../io/lock.js';
import { replay, activeLeases } from '../core/ledger-replay.js';
import { overlaps } from '../core/globs.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';
import type { Policy } from '../core/schemas.js';

function nowIso(): string { return new Date().toISOString(); }

async function loadPolicy(repoRoot: string): Promise<Policy> {
  const text = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
  return yaml.parse(text) as Policy;
}

function parseFrontMatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('front matter not found');
  return yaml.parse(m[1] ?? '') as Record<string, unknown>;
}

export interface LeaseView {
  task: string;
  worker: string;
  areas: string[];
  expiresAt: string;
}

async function loadTaskAreas(repoRoot: string, taskId: string): Promise<string[]> {
  const taskPath = path.join(repoRoot, 'project-memory/tasks', `${taskId}.md`);
  let text: string;
  try {
    text = await readFile(taskPath, 'utf8');
  } catch {
    const err = new Error(`task ${taskId} not found at ${taskPath}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }
  const task = TaskSchema.parse(parseFrontMatter(text));
  return task.touches;
}

export async function leaseTake(
  repoRoot: string,
  taskId: string,
  opts: { worker: string; ttlMinutes: number; allowBranch?: boolean },
): Promise<{ taskId: string; worker: string; expiresAt: string; areas: string[] }> {
  const policy = await loadPolicy(repoRoot);
  const baseBranch = policy.default_branch ?? 'main';
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });

  const areas = await loadTaskAreas(repoRoot, taskId);
  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  const active = activeLeases(state);

  // Overlap check: any active lease on a DIFFERENT task whose areas overlap.
  for (const lease of active) {
    if (lease.task === taskId) {
      const err = new Error(
        `task ${taskId} already holds an active lease (worker: ${lease.worker}, expires ${lease.expiresAt}). Release it first: baton lease release ${taskId} --reason "re-take"`
      );
      (err as Error & { exitCode?: number }).exitCode = 5;
      throw err;
    }
    const conflict = lease.areas.some(a => areas.some(t => overlaps(a, t)));
    if (conflict) {
      const err = new Error(
        `lease refused: task ${taskId} touches areas overlapping active lease held by ${lease.worker} on ${lease.task} (expires ${lease.expiresAt}). ` +
        `Dispatch ${lease.task} first, or wait for TTL expiry.`
      );
      (err as Error & { exitCode?: number }).exitCode = 5;
      throw err;
    }
  }

  await withLock(repoRoot, async () => {
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'lease_acquired',
      task: taskId,
      worker: opts.worker,
      areas,
      ttl_minutes: opts.ttlMinutes,
    });
  });

  const expiresAt = new Date(Date.now() + opts.ttlMinutes * 60_000).toISOString();
  return { taskId, worker: opts.worker, expiresAt, areas };
}

export async function leaseRelease(
  repoRoot: string,
  taskId: string,
  opts: { reason: string; allowBranch?: boolean },
): Promise<{ taskId: string; reason: string }> {
  const policy = await loadPolicy(repoRoot);
  const baseBranch = policy.default_branch ?? 'main';
  await assertOnBaseBranch(repoRoot, baseBranch, { allowBranch: opts.allowBranch });

  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  const lease = state.leases.get(taskId);
  if (!lease || lease.releasedAt) {
    const err = new Error(`no active lease on ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 5;
    throw err;
  }

  await withLock(repoRoot, async () => {
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'lease_released',
      task: taskId,
      reason: opts.reason,
    });
  });
  return { taskId, reason: opts.reason };
}

export async function leaseList(repoRoot: string): Promise<LeaseView[]> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  return activeLeases(state);
}

export function formatLeaseTable(leases: LeaseView[]): string {
  if (leases.length === 0) return 'No active leases.';
  const lines = ['Active leases:'];
  for (const l of leases) {
    lines.push(`  ${l.task}  worker=${l.worker}  expires=${l.expiresAt}`);
    for (const a of l.areas) lines.push(`    touches: ${a}`);
  }
  return lines.join('\n');
}
