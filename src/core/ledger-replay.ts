// Ledger replay. Spec §3.6. Pure function of the ledger events.
// P0-2: blocked event has prior_status. unblocked restores to that.
// P0-4: verify_run has base_commit.
// P0-5: claim dedupe by task+statement+key.
// P0-6: claim_status dedupe by claim_id+status+anchor.commit+run_id.
// P0-11: rejected has follow_up_task ID (was boolean).
import type { LedgerEvent } from './schemas.js';
import { claimDedupeKey, claimStatusDedupeKey } from '../io/ledger-file.js';

export type TaskStatus = 'draft' | 'ready' | 'assigned' | 'in_review' | 'needs_work' | 'done' | 'rejected' | 'blocked';

export interface ReplayState {
  tasks: Map<string, {
    status: TaskStatus;
    lockedHash?: string;
    baseCommit?: string;
    priorStatus?: TaskStatus;  // for blocked -> unblocked
    latestVerifyHead?: string;
    followUpTask?: string;     // P0-11
  }>;
  claims: Map<string, {
    taskId: string;
    statement: string;
    key?: string;
    status: 'reported' | 'verified' | 'failed' | 'stale';
    anchor?: { commit: string; watch: string[] };
    runId?: string;
  }>;
  decisions: Map<string, {
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
    hash?: string;             // P0-3
  }>;
  lastVerifyBase: Map<string, string>;  // taskId -> base_commit (P0-4)
  leases: Map<string, {
    worker: string;
    areas: string[];
    ttlMinutes: number;
    acquiredAt: string;        // ISO ts of lease_acquired
    releasedAt?: string;       // ISO ts of lease_released (if released)
  }>;
}

export function replay(events: LedgerEvent[]): ReplayState {
  const state: ReplayState = {
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    lastVerifyBase: new Map(),
    leases: new Map(),
  };

  // Track dedupe keys to skip duplicates per P0-5, P0-6
  const seenClaimKeys = new Set<string>();
  const seenClaimStatusKeys = new Set<string>();

  for (const e of events) {
    if (e.type === 'task_locked') {
      state.tasks.set(e.task, { status: 'ready', lockedHash: e.hash, baseCommit: e.base_commit });
    } else if (e.type === 'task_unlocked') {
      state.tasks.set(e.task, { status: 'draft' });
    } else if (e.type === 'packet_issued') {
      const t = state.tasks.get(e.task);
      if (t) {
        if (t.status === 'ready' || t.status === 'needs_work') t.status = 'assigned';
      }
    } else if (e.type === 'claim') {
      const dedupeKey = claimDedupeKey({ task: e.task, statement: e.statement, key: e.key });
      if (seenClaimKeys.has(dedupeKey)) continue;
      seenClaimKeys.add(dedupeKey);
      state.claims.set(e.claim_id, {
        taskId: e.task,
        statement: e.statement,
        key: e.key,
        status: 'reported',
      });
    } else if (e.type === 'claim_status') {
      const dedupeKey = claimStatusDedupeKey({
        claim_id: e.claim_id,
        status: e.status,
        anchor: e.anchor,
        run_id: e.run_id,
      });
      if (seenClaimStatusKeys.has(dedupeKey)) continue;
      seenClaimStatusKeys.add(dedupeKey);
      const c = state.claims.get(e.claim_id);
      if (c) {
        c.status = e.status;
        if (e.anchor) c.anchor = e.anchor;
        if (e.run_id) c.runId = e.run_id;
      }
    } else if (e.type === 'verify_run') {
      const t = state.tasks.get(e.task);
      if (t) {
        state.lastVerifyBase.set(e.task, e.base_commit);  // P0-4
        t.latestVerifyHead = e.head_commit;
        // Per spec TABLE 3: verify_run all_pass transitions assigned → in_review.
        // Allow also from 'ready' (if packet was issued by hand without ledger event)
        // and from 'needs_work' (re-verify after fix).
        if (e.verdict === 'all_pass' && (t.status === 'assigned' || t.status === 'in_review' || t.status === 'needs_work' || t.status === 'ready')) {
          t.status = 'in_review';
        } else if (e.verdict === 'has_failures' || e.verdict === 'incomplete') {
          if (t.status !== 'in_review') t.status = 'needs_work';
        }
      }
    } else if (e.type === 'accepted') {
      const t = state.tasks.get(e.task);
      if (t) t.status = 'done';
    } else if (e.type === 'rejected') {
      const t = state.tasks.get(e.task);
      if (t) {
        t.status = 'rejected';
        if (e.follow_up_task) t.followUpTask = e.follow_up_task;  // P0-11
      }
    } else if (e.type === 'blocked') {
      // P0-2: prior_status stored on event
      const t = state.tasks.get(e.task);
      if (t) {
        t.priorStatus = t.status;
        t.status = 'blocked';
      }
    } else if (e.type === 'unblocked') {
      const t = state.tasks.get(e.task);
      if (t && t.priorStatus) {
        t.status = t.priorStatus;
        t.priorStatus = undefined;
      }
    } else if (e.type === 'decision_status') {
      const d = state.decisions.get(e.decision) ?? { status: 'proposed' as const };
      d.status = e.to as 'proposed' | 'accepted' | 'rejected' | 'superseded';
      if (e.hash) d.hash = e.hash;  // P0-3
      state.decisions.set(e.decision, d);
    } else if (e.type === 'lease_acquired') {
      // Latest acquire per task wins (re-lease after expiry is legal).
      state.leases.set(e.task, {
        worker: e.worker,
        areas: e.areas,
        ttlMinutes: e.ttl_minutes,
        acquiredAt: e.ts,
      });
    } else if (e.type === 'lease_released') {
      const l = state.leases.get(e.task);
      if (l && !l.releasedAt) l.releasedAt = e.ts;
    }
  }
  return state;
}

/**
 * v1.3.0: active (not released, not expired) leases at a given time.
 * Expiry = acquiredAt + ttlMinutes. Deterministic function of the ledger.
 */
export function activeLeases(
  state: ReplayState,
  nowMs: number = Date.now(),
): { task: string; worker: string; areas: string[]; expiresAt: string }[] {
  const out: { task: string; worker: string; areas: string[]; expiresAt: string }[] = [];
  for (const [task, l] of state.leases) {
    if (l.releasedAt) continue;
    const expiresMs = Date.parse(l.acquiredAt) + l.ttlMinutes * 60_000;
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) continue;
    out.push({ task, worker: l.worker, areas: l.areas, expiresAt: new Date(expiresMs).toISOString() });
  }
  return out.sort((a, b) => a.task.localeCompare(b.task));
}

/**
 * Find conflicts. Spec §7.3.
 * Two kinds: decision conflicts (same key, both accepted, neither supersedes)
 * and claim conflicts (live claims, same key, different statements).
 */
export function findConflicts(events: LedgerEvent[]): {
  decisionConflicts: { key: string; decisions: string[] }[];
  claimConflicts: { key: string; claims: { id: string; statement: string }[] }[];
} {
  const state = replay(events);
  const decisionByKey = new Map<string, string[]>();
  for (const [id, d] of state.decisions) {
    if (d.status !== 'accepted') continue;
    // We need the decision's key, which isn't in the event stream — needs file access
    // Skip for now; conflicts command will load decision files
  }
  // Claim conflicts: same key, live (not stale), different statements
  const claimsByKey = new Map<string, { id: string; statement: string; status: string }[]>();
  for (const [id, c] of state.claims) {
    if (!c.key) continue;
    if (c.status === 'stale') continue;
    const list = claimsByKey.get(c.key) ?? [];
    list.push({ id, statement: c.statement, status: c.status });
    claimsByKey.set(c.key, list);
  }
  const claimConflicts: { key: string; claims: { id: string; statement: string }[] }[] = [];
  for (const [key, list] of claimsByKey) {
    if (list.length > 1 && new Set(list.map(c => c.statement)).size > 1) {
      claimConflicts.push({ key, claims: list.map(c => ({ id: c.id, statement: c.statement })) });
    }
  }
  return { decisionConflicts: [], claimConflicts };
}
