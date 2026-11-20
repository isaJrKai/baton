// Stage 2.5 Item 5: worker checkout is a sibling folder, never under .baton/tmp.
// Startup cleanup must NEVER touch sibling ../wt-* worktrees.
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-sibling-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('Stage 2.5 Item 5: worker checkout is sibling, never .baton/tmp', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    // Clean up any sibling worktrees
    try {
      execSync(`rm -rf ${path.join(path.dirname(repoDir), 'wt-*')}`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    await rm(repoDir, { recursive: true, force: true });
  });

  it('packet prints sibling worktree command (../wt-<task>), not .baton/tmp', async () => {
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test"',
      'touches: ["src/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    execSync('git add -A && git commit -m "task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    const result = runBaton(['packet', 'T-0001'], repoDir);
    expect(result.code).toBe(0);
    // Must print sibling worktree command (../wt-T-0001, not .baton/tmp/wt-T-0001)
    expect(result.stdout).toContain('git worktree add ../wt-T-0001 -b baton/T-0001-<slug> main');
    expect(result.stdout).not.toContain('.baton/tmp/wt-');
    // Must print ledger commit reminder
    expect(result.stdout).toContain('Ledger updated. Commit on main:');
  });

  it('startup cleanup never touches sibling ../wt-* worktrees', async () => {
    // Create a sibling worktree manually (simulating what the worker would do)
    const siblingPath = path.join(path.dirname(repoDir), 'wt-T-0001-test');
    execSync(`git worktree add "${siblingPath}" -b baton/T-0001-test main`, { cwd: repoDir, stdio: 'pipe' });

    // Verify the sibling worktree exists
    await access(siblingPath);

    // Run any baton command (triggers startup cleanup)
    const result = runBaton(['task', 'list'], repoDir);
    expect(result.code).toBe(0);

    // The sibling worktree must STILL exist — cleanup must NOT touch it
    await access(siblingPath);

    // Verify via git worktree list that it's still registered
    const wtList = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(wtList).toContain('wt-T-0001-test');
  });

  it('startup cleanup removes stale .baton/tmp/wt-* worktrees but not siblings', async () => {
    // Create a stale .baton/tmp/wt-* worktree (simulating a killed verify run)
    await mkdir(path.join(repoDir, '.baton/tmp'), { recursive: true });
    const stalePath = path.join(repoDir, '.baton/tmp/wt-T-0001-r-0001-99999');
    execSync(`git worktree add --detach "${stalePath}" HEAD`, { cwd: repoDir, stdio: 'pipe' });

    // Also create a sibling worktree
    const siblingPath = path.join(path.dirname(repoDir), 'wt-T-0001-real');
    execSync(`git worktree add "${siblingPath}" -b baton/T-0001-real main`, { cwd: repoDir, stdio: 'pipe' });

    // Both exist
    await access(stalePath);
    await access(siblingPath);

    // Run a baton command (triggers startup cleanup)
    runBaton(['task', 'list'], repoDir);

    // The stale .baton/tmp worktree should be REMOVED
    let staleExists = true;
    try { await access(stalePath); } catch { staleExists = false; }
    expect(staleExists).toBe(false);

    // The sibling worktree must STILL exist
    await access(siblingPath);
  });
});
