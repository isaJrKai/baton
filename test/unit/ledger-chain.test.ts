// v1.3.2 P3: ledger tamper-evidence. Entries carry prev_hash = the computed
// hash of the entry they were appended after (or '' for the very first entry).
// Verification is fork-tolerant: a prev_hash must match SOME earlier entry in
// the file, so a union merge of two branches that both appended stays valid
// (each branch's first entry references the common fork-tail, which is still
// earlier in the merged file). Tampering with any referenced entry breaks the
// chain and doctor reports E_LEDGER_CHAIN_BREAK.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendLedger, appendLedgerBatch, readLedger, eventHash } from '../../src/io/ledger-file.js';
import { doctor } from '../../src/commands/doctor.js';

type AnyEvent = Record<string, unknown> & { id: string; type: string; ts: string; v: number };

function ev(id: string, type: string, extra: Record<string, unknown> = {}): AnyEvent {
  return { v: 1, id, ts: '2025-01-01T00:00:00.000Z', type, ...extra };
}

describe('eventHash (v1.3.2 P3)', () => {
  it('is stable for identical events', () => {
    const a = ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' });
    const b = ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' });
    expect(eventHash(a)).toBe(eventHash(b));
  });

  it('changes when any field is tampered with', () => {
    const a = ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' });
    const b = { ...a, ts: '2025-01-02T00:00:00.000Z' };
    expect(eventHash(a)).not.toBe(eventHash(b));
  });

  it('ignores prev_hash itself (so verification can recompute)', () => {
    const a = ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' });
    const b = { ...a, prev_hash: 'deadbeef' };
    expect(eventHash(a)).toBe(eventHash(b));
  });
});

describe('appendLedger chain (v1.3.2 P3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'baton-ledger-chain-'));
    await mkdir(path.join(dir, 'project-memory'), { recursive: true });
    await mkdir(path.join(dir, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('first append gets empty prev_hash, second references the first', async () => {
    await appendLedger(dir, ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' }) as never);
    await appendLedger(dir, ev('e-000002', 'task_unlocked', { task: 'T-0001', reason: 'r' }) as never);
    const { events } = await readLedger(dir);
    expect(events).toHaveLength(2);
    const first = events[0] as unknown as { prev_hash?: string };
    const second = events[1] as unknown as { prev_hash?: string };
    expect(first.prev_hash).toBe('');
    expect(second.prev_hash).toBe(eventHash(events[0]));
  });

  it('batch append chains within the batch', async () => {
    await appendLedgerBatch(dir, [
      ev('e-000001', 'verify_run', { run_id: 'r-0001', task: 'T-0001', base_commit: 'b', head_commit: 'h', verdict: 'all_pass' }),
      ev('e-000002', 'check_result', { run_id: 'r-0001', task: 'T-0001', check: 'tests', result: 'pass' }),
      ev('e-000003', 'check_result', { run_id: 'r-0001', task: 'T-0001', check: 'scope', result: 'pass' }),
    ] as never);
    const { events } = await readLedger(dir);
    expect(events).toHaveLength(3);
    expect((events[0] as unknown as { prev_hash: string }).prev_hash).toBe('');
    expect((events[1] as unknown as { prev_hash: string }).prev_hash).toBe(eventHash(events[0]));
    expect((events[2] as unknown as { prev_hash: string }).prev_hash).toBe(eventHash(events[1]));
  });

  it('a new append after a hand-written legacy tail references the tail', async () => {
    // Legacy ledger without prev_hash fields (pre-v1.3.2)
    const legacy = [
      JSON.stringify(ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' })),
      '',
    ].join('\n');
    await writeFile(path.join(dir, 'project-memory', 'ledger.jsonl'), legacy);
    await appendLedger(dir, ev('e-000002', 'task_unlocked', { task: 'T-0001', reason: 'r' }) as never);
    const { events } = await readLedger(dir);
    expect((events[1] as unknown as { prev_hash: string }).prev_hash).toBe(eventHash(events[0]));
  });
});

describe('doctor chain verification (v1.3.2 P3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'baton-ledger-doctor-'));
    await mkdir(path.join(dir, 'project-memory'), { recursive: true });
    await mkdir(path.join(dir, '.baton'), { recursive: true });
    await appendLedger(dir, ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' }) as never);
    await appendLedger(dir, ev('e-000002', 'task_unlocked', { task: 'T-0001', reason: 'r' }) as never);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('a consistent chain produces no chain findings', async () => {
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'E_LEDGER_CHAIN_BREAK')).toBeUndefined();
  });

  it('tampering with a referenced entry breaks the chain (E_LEDGER_CHAIN_BREAK)', async () => {
    const file = path.join(dir, 'project-memory', 'ledger.jsonl');
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter(l => l.length > 0);
    const e0 = JSON.parse(lines[0]!) as AnyEvent;
    e0.ts = '2025-06-01T00:00:00.000Z';  // tamper: keep id, change payload
    lines[0] = JSON.stringify(e0);
    await writeFile(file, lines.join('\n') + '\n');
    const { findings } = await doctor(dir);
    const broken = findings.find(f => f.code === 'E_LEDGER_CHAIN_BREAK');
    expect(broken).toBeDefined();
    expect(broken?.message).toContain('e-000002');
  });

  it('a legacy ledger without prev_hash fields is still clean', async () => {
    const file = path.join(dir, 'project-memory', 'ledger.jsonl');
    const legacy = [
      JSON.stringify(ev('e-000001', 'task_locked', { task: 'T-0001', hash: 'h1', base_commit: 'b' })),
      JSON.stringify(ev('e-000002', 'task_unlocked', { task: 'T-0001', reason: 'r' })),
      '',
    ].join('\n');
    await writeFile(file, legacy);
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'E_LEDGER_CHAIN_BREAK')).toBeUndefined();
  });

  it('a forward reference (citing a later entry) is a chain break', async () => {
    const { events } = await readLedger(dir);
    const file = path.join(dir, 'project-memory', 'ledger.jsonl');
    const lines = events.map(e => JSON.stringify(e));
    const e0 = JSON.parse(lines[0]!) as AnyEvent & { prev_hash: string };
    e0.prev_hash = eventHash(JSON.parse(lines[1]!));  // cites entry 2 while being entry 1
    lines[0] = JSON.stringify(e0);
    await writeFile(file, lines.join('\n') + '\n');
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'E_LEDGER_CHAIN_BREAK')).toBeDefined();
  });
});
