// v1.3.1 regression: union merge of two branches that both appended ledger events.
//
// .gitattributes sets `project-memory/ledger.jsonl merge=union` so merges of
// diverged worker branches auto-resolve by concatenating both sides' lines.
// The ledger is append-only JSONL with strictly increasing event IDs — two
// branches allocating from the same base produce DUPLICATE IDs after the merge
// (both run `nextEventId` against the same tail). This test proves:
//   1. the merge really happens and really collides,
//   2. `baton doctor` detects it (exit 3, E_DUPLICATE_EVENT_ID),
//   3. `baton doctor --fix` repairs it (renumber + ledger_repaired event),
//   4. ID allocation continues correctly after the repair,
//   5. claim/run ID collisions from a merge are remapped consistently.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { cliRunner } from '../helpers.js';
const CLI_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const ledgerWriteCommands = new Set(['verify', 'accept', 'reject', 'packet', 'report-check', 'decide']);
  const ledgerWriteTaskSubs = new Set(['ready', 'block', 'unblock', 'unlock']);
  let isLedgerWrite = false;
  if (args.length > 0 && ledgerWriteCommands.has(args[0] ?? '')) isLedgerWrite = true;
  if (args.length > 1 && args[0] === 'task' && ledgerWriteTaskSubs.has(args[1] ?? '')) isLedgerWrite = true;
  const needsAllowBranch = isLedgerWrite && !args.includes('--no-allow-branch');
  const needsAllowWeak = args.length > 1 && args[0] === 'task' && args[1] === 'ready' && !args.includes('--allow-weak');
  const finalArgs = [
    ...args.filter(a => a !== '--no-allow-branch'),
    ...(needsAllowBranch ? ['--allow-branch'] : []),
    ...(needsAllowWeak ? ['--allow-weak', 'test allows weak checks'] : []),
  ];
  const quotedArgs = finalArgs.map(a => a.includes(' ') ? `"${a}"` : a);
  try {
    const stdout = execSync(`${cliRunner()} ${quotedArgs.join(' ')}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

function gitSync(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

interface LedgerLine { [k: string]: unknown; id: string; type: string; ts: string; v: number }

async function readLedgerLines(repoDir: string): Promise<LedgerLine[]> {
  const text = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
  return text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as LedgerLine);
}

async function writeLedgerLines(repoDir: string, lines: object[]): Promise<void> {
  await writeFile(path.join(repoDir, 'project-memory/ledger.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('v1.3.1: ledger survives union merge of diverged branches', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'baton-ledger-merge-'));
    gitSync('git init -b main', repoDir);
    gitSync('git config user.email test@baton.local', repoDir);
    gitSync('git config user.name "Baton Test"', repoDir);
    await writeFile(path.join(repoDir, 'README.md'), '# test\n');
    gitSync('git add -A && git commit -m "init"', repoDir);
    runBaton(['init'], repoDir);
    // Commit the baton scaffold (incl. .gitattributes with merge=union) before branching.
    gitSync('git add -A && git commit -m "baton init"', repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('two branches each append, union merge collides IDs, doctor detects, --fix repairs', async () => {
    // Base ledger on main: task_locked = e-000001
    runBaton(['task', 'new', 'Add feature', '--touches', 'src/feature.ts'], repoDir);
    gitSync('git add -A && git commit -m "task T-0001"', repoDir);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);

    // Worker A appends packet_issued as e-000002, commits.
    gitSync('git checkout -b worker-a', repoDir);
    const pa = runBaton(['packet', 'T-0001'], repoDir);
    expect(pa.code).toBe(0);
    gitSync('git add -A && git commit -m "packet on worker-a"', repoDir);

    // Worker B branches from the same main, appends packet_issued as e-000002 too.
    gitSync('git checkout -b worker-b main', repoDir);
    const pb = runBaton(['packet', 'T-0001'], repoDir);
    expect(pb.code).toBe(0);
    gitSync('git add -A && git commit -m "packet on worker-b"', repoDir);

    // Pre-merge sanity: each branch alone is consistent.
    const aloneA = runBaton(['doctor'], repoDir);
    expect(aloneA.code).toBe(0);

    // Union merge: ledger.jsonl merge=union auto-resolves by keeping both lines.
    gitSync('git merge worker-a --no-edit', repoDir);

    const merged = await readLedgerLines(repoDir);
    expect(merged.length).toBe(3); // task_locked + 2x packet_issued
    const ids = merged.map(e => e.id);
    expect(ids.filter(i => i === 'e-000002').length).toBe(2); // the collision, exactly as suspected
    const packetEvents = merged.filter(e => e.type === 'packet_issued');
    expect(packetEvents.length).toBe(2);
    expect((packetEvents[0] as unknown as { packet_sha256: string }).packet_sha256)
      .not.toBe((packetEvents[1] as unknown as { packet_sha256: string }).packet_sha256);

    // 1. doctor detects the broken ledger (exit 3)
    const detected = runBaton(['doctor'], repoDir);
    expect(detected.code).toBe(3);
    expect(detected.stdout).toContain('E_DUPLICATE_EVENT_ID');
    // v1.3.2 P3: the prev_hash chain is fork-tolerant — both branches chained
    // onto the same fork-tail entry, which is still earlier in the merged
    // file. The union merge must NOT break the chain.
    expect(detected.stdout).not.toContain('E_LEDGER_CHAIN_BREAK');

    // 2. doctor --fix repairs: renumber, append ledger_repaired event
    const fixed = runBaton(['doctor', '--fix'], repoDir);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain('ledger_repaired event appended');

    const repaired = await readLedgerLines(repoDir);
    expect(repaired.length).toBe(4); // 3 original + ledger_repaired
    const repairedIds = repaired.map(e => e.id);
    expect(repairedIds).toEqual(['e-000001', 'e-000002', 'e-000003', 'e-000004']);
    expect(repaired.filter(e => e.type === 'packet_issued').length).toBe(2); // both events survive
    expect(repaired[3]!.type).toBe('ledger_repaired');

    // 3. doctor is clean after the fix
    const clean = runBaton(['doctor'], repoDir);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('No issues found');

    // 4. ID allocation continues from the repaired tail
    const again = runBaton(['packet', 'T-0001'], repoDir);
    expect(again.code).toBe(0);
    const after = await readLedgerLines(repoDir);
    expect(after[after.length - 1]!.id).toBe('e-000005'); // not another e-000002
    const stillClean = runBaton(['doctor'], repoDir);
    expect(stillClean.code).toBe(0);
  });

  it('doctor --fix remaps colliding claim and run IDs consistently', async () => {
    // Real task file must exist on main for doctor's locked-hash check.
    runBaton(['task', 'new', 'Add feature', '--touches', 'src/feature.ts'], repoDir);
    gitSync('git add -A && git commit -m "task T-0001"', repoDir);

    // Hand-write the post-merge state of two branches that each ran a full
    // verify cycle from the same base: both allocated c-0001 and r-0001.
    const ts = '2025-01-01T00:00:00.000Z';
    await writeLedgerLines(repoDir, [
      { v: 1, id: 'e-000001', ts, type: 'task_locked', task: 'T-0001', hash: 'a'.repeat(64), base_commit: 'b'.repeat(40) },
      { v: 1, id: 'e-000002', ts, type: 'claim', claim_id: 'c-0001', task: 'T-0001', statement: 'stmt A', key: 'k.a', report_sha256: 'x' },
      { v: 1, id: 'e-000003', ts, type: 'claim_status', claim_id: 'c-0001', status: 'verified', reason: 'ok', run_id: 'r-0001' },
      // Branch B's appends — same IDs, different claims
      { v: 1, id: 'e-000002', ts, type: 'claim', claim_id: 'c-0001', task: 'T-0002', statement: 'stmt B', key: 'k.b', report_sha256: 'y' },
      { v: 1, id: 'e-000003', ts, type: 'claim_status', claim_id: 'c-0001', status: 'verified', reason: 'ok', run_id: 'r-0001' },
      { v: 1, id: 'e-000004', ts, type: 'verify_run', run_id: 'r-0001', task: 'T-0001', base_commit: 'b'.repeat(40), head_commit: 'h'.repeat(40), verdict: 'all_pass' },
      { v: 1, id: 'e-000004', ts, type: 'verify_run', run_id: 'r-0001', task: 'T-0002', base_commit: 'b'.repeat(40), head_commit: 'h'.repeat(40), verdict: 'has_failures' },
    ]);

    const detected = runBaton(['doctor'], repoDir);
    expect(detected.code).toBe(3);

    const fixed = runBaton(['doctor', '--fix'], repoDir);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain('remapped 2 claim ID(s)');
    expect(fixed.stdout).toContain('remapped 1 run ID(s)');

    const repaired = await readLedgerLines(repoDir);
    // 7 original + ledger_repaired
    expect(repaired.length).toBe(8);
    for (let i = 0; i < repaired.length; i++) {
      expect(repaired[i]!.id).toBe(`e-${String(i + 1).padStart(6, '0')}`);
    }
    // Claims are now distinct; statements preserved
    const claims = repaired.filter(e => e.type === 'claim');
    expect(claims.map(c => c.claim_id).sort()).toEqual(['c-0001', 'c-0002']);
    expect(new Set(claims.map(c => c.statement))).toEqual(new Set(['stmt A', 'stmt B']));
    // claim_status references follow the remap
    const statuses = repaired.filter(e => e.type === 'claim_status');
    expect(statuses.map(s => s.claim_id).sort()).toEqual(['c-0001', 'c-0002']);
    // Run IDs distinct: first verify keeps r-0001, second becomes r-0002
    const runs = repaired.filter(e => e.type === 'verify_run');
    expect(runs.map(r => `${r.task}:${r.run_id}`).sort()).toEqual(['T-0001:r-0001', 'T-0002:r-0002']);
    expect(repaired[7]!.type).toBe('ledger_repaired');

    const clean = runBaton(['doctor'], repoDir);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('No issues found');
  });
});
