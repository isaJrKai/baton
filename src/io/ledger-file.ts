// Ledger file. P0-8: lock held across read-write-fsync transaction.
// P0-5, P0-6: dedupe keys for claim and claim_status events.
// v1.3.2 P3: tamper-evidence — every entry carries prev_hash, the computed
// hash of the entry it was appended after ('' for the very first entry).
// Verification is fork-tolerant: a prev_hash must match SOME earlier entry in
// the file, so a union merge of two branches that both appended stays valid —
// each branch's first entry references the common fork-tail, which is still
// earlier in the merged file. See doctor's E_LEDGER_CHAIN_BREAK.
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withLock } from './lock.js';
import { sha256Sync } from './hash.js';
import type { LedgerEvent } from '../core/schemas.js';

const LEDGER_PATH = 'project-memory/ledger.jsonl';
const MAX_LINE_BYTES = 64 * 1024;

function ledgerFile(repoRoot: string): string {
  return path.join(repoRoot, LEDGER_PATH);
}

/**
 * v1.3.2 P3: computed hash of a ledger event — sha256 over its canonical JSON
 * EXCLUDING prev_hash (so verification can recompute it for any entry).
 * Key order is the object's insertion order, which is deterministic for events
 * written by baton and preserved by JSON.parse.
 */
export function eventHash(event: LedgerEvent): string {
  const { prev_hash: _ignored, ...rest } = event as LedgerEvent & { prev_hash?: string };
  return sha256Sync(JSON.stringify(rest));
}

/**
 * v1.3.2 P3: computed hash of the last valid event in the ledger file, or ''
 * when the ledger is empty (genesis). Malformed tail lines are ignored —
 * doctor reports them separately.
 */
async function tailHash(repoRoot: string): Promise<string> {
  const { events } = await readLedger(repoRoot);
  const last = events[events.length - 1];
  return last ? eventHash(last) : '';
}

/**
 * Absolute path of the ledger file (exported for doctor --fix).
 */
export function ledgerPath(repoRoot: string): string {
  return ledgerFile(repoRoot);
}

/**
 * Rewrite the entire ledger atomically (tmp + rename + fsync). Used only by
 * `baton doctor --fix` after a union merge renumbers event IDs. Caller must
 * hold the lock (withLock) across the whole read-modify-write transaction.
 * v1.3.2 P3: rebuilds the prev_hash chain over the rewritten sequence.
 */
export async function rewriteLedger(repoRoot: string, events: LedgerEvent[]): Promise<void> {
  const { rename } = await import('node:fs/promises');
  let parent = '';
  const lines = events.map(e => {
    const entry = { ...e, prev_hash: parent } as LedgerEvent;
    const line = JSON.stringify(entry) + '\n';
    parent = eventHash(entry);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new Error(`ledger line exceeds 64KB: ${e.id}`);
    }
    return line;
  }).join('');
  const target = ledgerFile(repoRoot);
  const tmp = target + '.tmp';
  await mkdir(path.dirname(target), { recursive: true });
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(lines);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
}

/**
 * Append a single ledger event. Holds lock for the entire transaction:
 * read tail to confirm last id -> write line -> fsync -> release lock.
 * Per P0-8. v1.3.2 P3: prev_hash = computed hash of the current tail ('' when
 * the ledger is empty).
 */
export async function appendLedger(repoRoot: string, event: LedgerEvent): Promise<void> {
  const raw = JSON.stringify(event) + '\n';
  if (Buffer.byteLength(raw) > MAX_LINE_BYTES) {
    throw new Error(`ledger line exceeds 64KB: ${event.id}`);
  }
  await mkdir(path.dirname(ledgerFile(repoRoot)), { recursive: true });
  await withLock(repoRoot, async () => {
    const parent = await tailHash(repoRoot);
    const entry = { ...event, prev_hash: parent } as LedgerEvent;
    const line = JSON.stringify(entry) + '\n';
    const fh = await open(ledgerFile(repoRoot), 'a');
    try {
      await fh.writeFile(line);
      await fh.sync();  // P0-8: fsync before close
    } finally {
      await fh.close();
    }
  });
}

/**
 * Append multiple events. Single lock acquisition for the batch.
 * v1.3.2 P3: entries chain within the batch (first references the tail).
 */
export async function appendLedgerBatch(repoRoot: string, events: LedgerEvent[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(path.dirname(ledgerFile(repoRoot)), { recursive: true });
  await withLock(repoRoot, async () => {
    let parent = await tailHash(repoRoot);
    const lines = events.map(e => {
      const entry = { ...e, prev_hash: parent } as LedgerEvent;
      parent = eventHash(entry);
      const line = JSON.stringify(entry) + '\n';
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        throw new Error(`ledger line exceeds 64KB: ${e.id}`);
      }
      return line;
    }).join('');
    const fh = await open(ledgerFile(repoRoot), 'a');
    try {
      await fh.writeFile(lines);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

/**
 * Read the ledger as a list of parsed events.
 * Lines that fail to parse are returned in the malformed list.
 */
export async function readLedger(repoRoot: string): Promise<{
  events: LedgerEvent[];
  malformed: { line: number; text: string }[];
}> {
  let text: string;
  try {
    text = await readFile(ledgerFile(repoRoot), 'utf8');
  } catch {
    return { events: [], malformed: [] };
  }
  const lines = text.split('\n').filter(l => l.length > 0);
  const events: LedgerEvent[] = [];
  const malformed: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      malformed.push({ line: i + 1, text: line });
    }
  }
  return { events, malformed };
}

/**
 * Allocate the next event ID (e-000001 format, 6 digits).
 * Caller must hold the lock or use withLock.
 */
export async function nextEventId(repoRoot: string): Promise<string> {
  const { events } = await readLedger(repoRoot);
  const existing = events.map(e => e.id);
  const nums = existing
    .map(s => parseInt(s.split('-')[1] ?? '0', 10))
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `e-${String(next).padStart(6, '0')}`;
}

/**
 * Allocate the next claim ID (c-0001 format, 4 digits).
 * Caller must hold the lock or use withLock.
 */
export async function nextClaimId(repoRoot: string): Promise<string> {
  const { events } = await readLedger(repoRoot);
  const existing = events
    .filter(e => e.type === 'claim' && 'claim_id' in e)
    .map(e => (e as { claim_id: string }).claim_id);
  const nums = existing
    .map(s => parseInt(s.split('-')[1] ?? '0', 10))
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `c-${String(next).padStart(4, '0')}`;
}

/**
 * Allocate the next run ID (r-0001 format, 4 digits).
 */
export async function nextRunId(repoRoot: string): Promise<string> {
  const { events } = await readLedger(repoRoot);
  const existing = events
    .filter(e => e.type === 'verify_run' && 'run_id' in e)
    .map(e => (e as { run_id: string }).run_id);
  const nums = existing
    .map(s => parseInt(s.split('-')[1] ?? '0', 10))
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `r-${String(next).padStart(4, '0')}`;
}

// P0-5: claim dedupe by task+statement+key
export function claimDedupeKey(claim: {
  task: string; statement: string; key?: string;
}): string {
  return `${claim.task}|${claim.statement}|${claim.key ?? ''}`;
}

// P0-6: claim_status dedupe by claim_id + status + anchor.commit + run_id
export function claimStatusDedupeKey(event: {
  claim_id: string; status: string;
  anchor?: { commit: string }; run_id?: string;
}): string {
  const commit = event.anchor?.commit ?? '';
  const runId = event.run_id ?? '';
  return `${event.claim_id}|${event.status}|${commit}|${runId}`;
}
