import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-int-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function writeCliWrapper(targetDir: string): Promise<void> {
  // We run the dev CLI via tsx directly from the project root
  // No wrapper needed — we use `npx tsx src/cli.ts ...` from baton-cli/ directory
}

const CLI_DIR = '/home/z/my-project/baton-cli';

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  // Auto-append --allow-branch to ledger-writing commands when not on main.
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
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

describe('Stage 1 integration: end-to-end workflow', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    // Initial commit so HEAD exists
    await writeFile(path.join(repoDir, 'README.md'), '# test\n');
    execSync('git add -A && git commit -m "initial"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('baton init creates scaffold', () => {
    const result = runBaton(['init'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Created:');
    expect(result.stdout).toContain('project-memory/STATE.md');
    expect(result.stdout).toContain('.baton/policy.yml');
    expect(result.stdout).toContain('Next steps:');
  });

  it('baton init is idempotent', () => {
    runBaton(['init'], repoDir);
    const result = runBaton(['init'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Skipped (already exist)');
  });

  it('baton init refuses when not a git repo', async () => {
    const nonGitDir = await mkdtemp(path.join(tmpdir(), 'baton-nongit-'));
    try {
      const result = runBaton(['init'], nonGitDir);
      expect(result.code).toBe(7);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('creates decision and accepts it (P0-3 hash check)', () => {
    runBaton(['init'], repoDir);

    const decide = runBaton([
      'decide', 'Use picomatch for globs', '--key', 'core.globs.engine', '--areas', 'src/**',
    ], repoDir);
    expect(decide.code).toBe(0);
    expect(decide.stdout).toContain('Created decision D-0001');

    // Commit the decision before accepting
    execSync('git add -A && git commit -m "add D-0001"', { cwd: repoDir, stdio: 'pipe' });

    const accept = runBaton(['decide', 'accept', 'D-0001'], repoDir);
    expect(accept.code).toBe(0);
    expect(accept.stdout).toContain('accepted');
  });

  it('creates task and locks it (P0-13 strength warning)', () => {
    runBaton(['init'], repoDir);

    // Create a decision first (required because task.ready validates accepted decisions)
    runBaton([
      'decide', 'Use picomatch', '--key', 'core.globs', '--areas', 'src/**',
    ], repoDir);
    execSync('git add -A && git commit -m "add D-0001"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['decide', 'accept', 'D-0001'], repoDir);
    // No need to commit accept — accept only updates the ledger, not the file content

    const task = runBaton([
      'task', 'new', 'Implement globs', '--touches', 'src/globs.ts',
    ], repoDir);
    expect(task.code).toBe(0);
    expect(task.stdout).toContain('Created task T-0001');

    // Commit task on main
    execSync('git add -A && git commit -m "add T-0001"', { cwd: repoDir, stdio: 'pipe' });

    const ready = runBaton(['task', 'ready', 'T-0001'], repoDir);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain('Task T-0001 locked');
    // v1.2: task ready blocks on no behavior check, but --allow-weak auto-added by test helper
    expect(ready.stdout).toContain('weak checks allowed');
  });

  it('baton task lint reports check strength', () => {
    runBaton(['init'], repoDir);
    runBaton(['task', 'new', 'Test', '--touches', 'src/**'], repoDir);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });

    const lint = runBaton(['task', 'lint', 'T-0001'], repoDir);
    expect(lint.code).toBe(0);
    expect(lint.stdout).toContain('scope');
    expect(lint.stdout).toContain('diff_scope');
    expect(lint.stdout).toContain('hygiene');
  });

  it('baton upgrade exits 4 (P0-12)', () => {
    runBaton(['init'], repoDir);
    const result = runBaton(['upgrade'], repoDir);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('not needed at v1');
  });

  it('baton migrate exits 4 (P0-12)', () => {
    runBaton(['init'], repoDir);
    const result = runBaton(['migrate'], repoDir);
    expect(result.code).toBe(4);
  });
});
