// Stage 2.5 Item 1: merge-base regression test.
// Worker branches from main at commit X. Main advances (ledger commit).
// verify must diff from merge-base(base, head), NOT from main's tip.
// If it diffed from main's tip, the ledger commit would appear as an out-of-scope change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const ledgerWriteCommands = new Set(['verify', 'accept', 'reject', 'packet', 'report-check', 'decide']);
  const ledgerWriteTaskSubs = new Set(['ready', 'block', 'unblock', 'unlock']);
  let isLedgerWrite = false;
  if (args.length > 0 && ledgerWriteCommands.has(args[0] ?? '')) isLedgerWrite = true;
  if (args.length > 1 && args[0] === 'task' && ledgerWriteTaskSubs.has(args[1] ?? '')) isLedgerWrite = true;
  const needsAllowWeak = args.length > 1 && args[0] === 'task' && args[1] === 'ready' && !args.includes('--allow-weak');
  const finalArgs = [
    ...args,
    ...(isLedgerWrite ? ['--allow-branch'] : []),
    ...(needsAllowWeak ? ['--allow-weak', 'test allows weak checks'] : []),
  ];
  const quotedArgs = finalArgs.map(a => a.includes(' ') ? `"${a}"` : a);
  try {
    const stdout = execSync(`npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} ${quotedArgs.join(' ')}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-mergebase-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('Stage 2.5 Item 1: merge-base', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('verify diffs from merge-base, not base tip — main advances after worker branches', async () => {
    // Setup: task with scope check
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test merge-base"',
      'touches: ["src/api/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/api/**"], description: "only src/api may change" }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Worker branches from main NOW (at commit X)
    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
    const workerHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Write report
    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    const reportText = [
      '---',
      'baton_version: 1',
      'task: T-0001',
      'worker: test',
      'branch: baton/T-0001-test',
      `base_commit: ${baseCommit}`,
      `head_commit: ${workerHead}`,
      'claims: []',
      'changed_files:',
      '  - src/api/handler.ts',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // *** NOW: main advances. A ledger commit lands on main. ***
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    // Simulate a ledger commit: append a line to a file on main and commit
    await writeFile(path.join(repoDir, 'project-memory/CONSTRAINTS.md'), '# Constraints\n\nUpdated by main.\n');
    execSync('git add -A && git commit -m "main advances: update constraints"', { cwd: repoDir, stdio: 'pipe' });
    const newMainTip = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(newMainTip).not.toBe(baseCommit);  // main has advanced

    // Now verify T-0001. The diff must be from merge-base(base, head) = baseCommit,
    // NOT from newMainTip. If it diffed from newMainTip, the CONSTRAINTS.md change
    // would appear as an out-of-scope change and scope would FAIL.
    const result = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL_PASS');
    expect(result.stdout).toContain('scope');
    expect(result.stdout).toContain('PASS');
    // The CONSTRAINTS.md change on main must NOT appear in the diff
    expect(result.stdout).not.toContain('CONSTRAINTS.md');
    expect(result.stdout).not.toContain('outside allow');
  });

  it('verify diffs from merge-base — main advances with ledger.jsonl change', async () => {
    // Same setup but main advances by appending to ledger.jsonl
    // (which is always-denied in diff_scope). If verify diffed from base tip,
    // the ledger change would appear as a denied-path violation.
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test merge-base with ledger"',
      'touches: ["src/api/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/api/**"] }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker"', { cwd: repoDir, stdio: 'pipe' });
    const workerHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    const reportText = [
      '---',
      'baton_version: 1',
      'task: T-0001',
      'worker: test',
      'branch: baton/T-0001-test',
      `base_commit: ${baseCommit}`,
      `head_commit: ${workerHead}`,
      'claims: []',
      'changed_files:',
      '  - src/api/handler.ts',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Main advances: a ledger.jsonl commit lands on main
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    const ledgerPath = path.join(repoDir, 'project-memory/ledger.jsonl');
    const ledgerContent = await readFile(ledgerPath, 'utf8').catch(() => '');
    // Append a fake event to ledger (simulating another baton command writing to it)
    await writeFile(ledgerPath, ledgerContent + '{"v":1,"id":"e-999999","ts":"2026-09-30T12:00:00Z","type":"task_locked","task":"T-9999","hash":"fake","base_commit":"fake"}\n');
    execSync('git add -A && git commit -m "main advances: ledger commit"', { cwd: repoDir, stdio: 'pipe' });

    // Verify must use merge-base, so the ledger.jsonl change on main does NOT appear in diff
    const result = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL_PASS');
    // The ledger.jsonl change on main must NOT appear as a scope violation
    expect(result.stdout).not.toContain('ledger.jsonl');
    expect(result.stdout).not.toContain('denied path');
  });
});
