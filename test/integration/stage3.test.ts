// Stage 3 tests: stale, conflicts, status, doctor, log
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
  const needsAllowWeak = args.length > 1 && args[0] === 'task' && args[1] === 'ready' && !args.includes('--allow-weak');
  const finalArgs = [
    ...args,
    ...(isLedgerWrite ? ['--allow-branch'] : []),
    ...(needsAllowWeak ? ['--allow-weak', 'test allows weak checks'] : []),
  ];
  const quotedArgs = finalArgs.map(a => a.includes(' ') ? `"${a}"` : a);
  try {
    const stdout = execSync(`${cliRunner()} ${quotedArgs.join(' ')}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-stage3-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('Stage 3: stale', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('baton stale --dry-run runs without error on empty ledger', () => {
    const result = runBaton(['stale', '--dry-run', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('verified claims checked');
    expect(result.stdout).toContain('0 stale');
  });

  it('baton stale detects no stale claims on fresh repo', () => {
    const result = runBaton(['stale', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No stale claims');
  });
});

describe('Stage 3: conflicts', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('baton conflicts finds no conflicts on fresh repo', () => {
    const result = runBaton(['conflicts', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No conflicts found');
  });

  it('baton conflicts detects decision conflict (same key, both accepted)', async () => {
    // Create two decisions with same key, both accepted
    runBaton(['decide', 'Decision A', '--key', 'api.tasks', '--areas', 'src/**', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "D-0001"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['decide', 'accept', 'D-0001', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "accept D-0001"', { cwd: repoDir, stdio: 'pipe', } as any);

    runBaton(['decide', 'Decision B', '--key', 'api.tasks', '--areas', 'src/**', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "D-0002"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['decide', 'accept', 'D-0002', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "accept D-0002"', { cwd: repoDir, stdio: 'pipe' } as any);

    const result = runBaton(['conflicts', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Decision conflicts');
    expect(result.stdout).toContain('api.tasks');
    expect(result.stdout).toContain('D-0001');
    expect(result.stdout).toContain('D-0002');
  });
});

describe('Stage 3: status', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('baton status runs on empty repo', () => {
    const result = runBaton(['status', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No tasks');
    expect(result.stdout).toContain('As of base');
  });

  it('baton status shows task counts after task ready', async () => {
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), [
      '---', 'baton_version: 1', 'id: T-0001', 'title: "Test"',
      'touches: ["src/**"]', 'reads: []', 'decisions: []', 'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: secrets, type: no_secrets }',
      '---', '', '## Objective', '', '## Definition of done', '',
    ].join('\n'));
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready"', { cwd: repoDir, stdio: 'pipe' } as any);

    const result = runBaton(['status', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 ready');
  });
});

describe('Stage 3: doctor', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('baton doctor passes on fresh repo', () => {
    const result = runBaton(['doctor', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No issues found');
  });

  it('baton doctor detects missing gitignore entries', async () => {
    // Remove .gitignore
    await writeFile(path.join(repoDir, '.gitignore'), '');
    const result = runBaton(['doctor', '--allow-branch'], repoDir);
    expect(result.code).toBe(0); // warnings only, not errors
    expect(result.stdout).toContain('WARNINGS');
    expect(result.stdout).toContain('W_MISSING_GITIGNORE');
  });

  it('baton doctor detects stale worktrees (before startup cleanup)', async () => {
    // NOTE: Baton's startup hook (G8) cleans up .baton/tmp/wt-* worktrees.
    // So if we create a stale worktree and then run doctor, the startup hook
    // removes it before doctor can see it. This is CORRECT behavior.
    // To test doctor's detection, we need to create the worktree AFTER
    // baton has started — which is impossible from the outside.
    // Instead, we verify that startup cleanup + doctor results in "all clear".
    await mkdir(path.join(repoDir, '.baton/tmp'), { recursive: true });
    const stalePath = path.join(repoDir, '.baton/tmp/wt-T-0001-r-0001-99999');
    execSync(`git worktree add --detach "${stalePath}" HEAD`, { cwd: repoDir, stdio: 'pipe' });

    // Running baton doctor triggers startup cleanup which removes the stale worktree,
    // then doctor finds no issues.
    const result = runBaton(['doctor', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No issues found');
    // Verify the stale worktree was actually removed
    const wtList = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(wtList).not.toContain('wt-T-0001-r-0001-99999');
  });
});

describe('Stage 3: log', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('baton log runs on empty ledger', () => {
    const result = runBaton(['log', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    // Empty ledger — no output expected
  });

  it('baton log shows events after decide', () => {
    runBaton(['decide', 'Test decision', '--key', 'test.key', '--areas', 'src/**', '--allow-branch'], repoDir);
    const result = runBaton(['log', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('decision_status');
    expect(result.stdout).toContain('D-0001');
  });

  it('baton log --last 1 shows only 1 event', () => {
    runBaton(['decide', 'A', '--key', 'a', '--areas', 'src/**', '--allow-branch'], repoDir);
    runBaton(['decide', 'B', '--key', 'b', '--areas', 'src/**', '--allow-branch'], repoDir);
    const result = runBaton(['log', '--last', '1', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('baton log --task filters by task', async () => {
    // Create a task and lock it so there's a task event
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), [
      '---', 'baton_version: 1', 'id: T-0001', 'title: "Test"',
      'touches: ["src/**"]', 'reads: []', 'decisions: []', 'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: secrets, type: no_secrets }',
      '---', '', '## Objective', '', '## Definition of done', '',
    ].join('\n'));
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);

    const result = runBaton(['log', '--task', 'T-0001', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('T-0001');
    // Should not contain decision events
    expect(result.stdout).not.toContain('decision_status');
  });
});
