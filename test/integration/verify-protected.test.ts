// v1.3.1: a worker cannot weaken the tests it is judged by.
//
// diff_scope stops edits outside the allowed files, but when test files are
// INSIDE scope the worker can rewrite them to pass. verify now:
//   - restores the merge-base versions of policy.protected_paths into the
//     worktree before running checks (the locked tests judge the work), and
//   - adds a protected_paths verdict row (fail unless the task sets
//     allow_protected — the explicit opt-in for tasks that change tests).
//
// The proof is a contrast: the same worker diff produces a PASS cmd check
// (base test judged it) without allow_protected, and a FAIL cmd check
// (worker's own test judged it) with allow_protected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CLI_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

const POLICY = `baton_version: 1
default_branch: main
token_budget: 6000
execution:
  mode: local
  acknowledged: true
  timeout_seconds: 60
allowed_commands:
  - "node test/check.js"
env_passthrough: []
never_include:
  - ".env*"
protected_paths:
  - "test/**"
`;

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
    const stdout = execSync(`npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} ${quotedArgs.join(' ')}`, {
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

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-protected-'));
  gitSync('git init -b main', dir);
  gitSync('git config user.email test@baton.local', dir);
  gitSync('git config user.name "Baton Test"', dir);
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  // The LOCKED test the worker is judged by: passes, and is distinguishable
  // from the worker's rewrite (which exits 1).
  await mkdir(path.join(dir, 'test'), { recursive: true });
  await writeFile(path.join(dir, 'test', 'check.js'), 'process.exit(0);\n');
  gitSync('git add -A && git commit -m "init"', dir);
  await mkdir(path.join(dir, '.baton'), { recursive: true });
  await writeFile(path.join(dir, '.baton', 'policy.yml'), POLICY);
  gitSync('git add -A && git commit -m "policy"', dir);
  return dir;
}

async function setupTask(repoDir: string, opts: { allowProtected?: boolean; extraFileExistsCheck?: boolean }): Promise<void> {
  const checks = [
    '  - { id: tests, type: cmd, run: "node test/check.js" }',
    '  - { id: scope, type: diff_scope, allow: ["src/feature.ts", "test/check.js"] }',
    '  - { id: secrets, type: no_secrets }',
  ];
  if (opts.extraFileExistsCheck) {
    checks.push('  - { id: no_extra_test, type: file_exists, path: "test/extra.test.js", exists: false }');
  }
  const lines = [
    '---',
    'baton_version: 1',
    'id: T-0001',
    'title: "Implement feature"',
    'touches: ["src/feature.ts", "test/check.js"]',
    'reads: []',
    'decisions: []',
    'non_goals: []',
    ...(opts.allowProtected ? ['allow_protected: true'] : []),
    'checks:',
    ...checks,
    '---',
    '',
    '## Objective',
    '',
    '## Definition of done',
    '',
  ];
  await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
  await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), lines.join('\n'));
  gitSync('git add -A && git commit -m "task T-0001"', repoDir);
}

async function workerEditsTests(repoDir: string, opts: { addExtraTest?: boolean } = {}): Promise<void> {
  // Worker branch: writes the in-scope source file AND rewrites the test it
  // will be judged by (inside touches scope, so diff_scope alone permits it).
  gitSync('git checkout -b baton/T-0001-test', repoDir);
  await mkdir(path.join(repoDir, 'src'), { recursive: true });
  await writeFile(path.join(repoDir, 'src', 'feature.ts'), 'export const feature = 1;\n');
  await writeFile(path.join(repoDir, 'test', 'check.js'), 'process.exit(1);\n'); // worker's "test"
  if (opts.addExtraTest) {
    await writeFile(path.join(repoDir, 'test', 'extra.test.js'), '// worker-added test file\n');
  }
  const baseCommit = gitSync('git rev-parse main', repoDir);
  gitSync('git add -A && git commit -m "worker output"', repoDir);
  const head = gitSync('git rev-parse HEAD', repoDir);

  await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
  const changed = ['src/feature.ts', 'test/check.js'];
  if (opts.addExtraTest) changed.push('test/extra.test.js');
  const report = [
    '---',
    'baton_version: 1',
    'task: T-0001',
    'worker: test',
    'branch: baton/T-0001-test',
    `base_commit: ${baseCommit.slice(0, 40)}`,
    `head_commit: ${head.slice(0, 40)}`,
    'claims: []',
    'changed_files:',
    ...changed.map(f => `  - ${f}`),
    '---',
    '',
    '## Summary',
    '',
    'Implemented feature.',
    '',
  ].join('\n');
  await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), report);
  gitSync('git add -A && git commit -m "report"', repoDir);
}

describe('v1.3.1: verify judges workers by the locked tests', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await setupRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('worker rewrote the test in scope: checks run on base version, protected_paths fails', async () => {
    await setupTask(repoDir, { allowProtected: false });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    await workerEditsTests(repoDir);

    const r = runBaton(['verify', 'T-0001'], repoDir);
    // The cmd check ran the LOCKED base test (exit 0) — not the worker's exit-1 rewrite.
    expect(r.stdout).toMatch(/tests\s+cmd\s+behavior\s+PASS/);
    // The tampering is visible and fails the verdict.
    expect(r.stdout).toContain('protected_paths');
    expect(r.stdout).toMatch(/protected_paths\s+protected\S*\s+hygiene\s+FAIL/);
    expect(r.stdout).toContain('Verdict: HAS_FAILURES');
    expect(r.code).toBe(6);
  });

  it('same diff with allow_protected: judged by worker versions, cmd check honestly fails', async () => {
    await setupTask(repoDir, { allowProtected: true });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    await workerEditsTests(repoDir);

    const r = runBaton(['verify', 'T-0001'], repoDir);
    // Explicit opt-in: checks run against the worker's own test (exit 1) — fail.
    expect(r.stdout).toMatch(/tests\s+cmd\s+behavior\s+FAIL/);
    expect(r.stdout).toContain('protected_paths');
    expect(r.stdout).toMatch(/protected_paths\s+protected\S*\s+hygiene\s+PASS/);
    expect(r.stdout).toContain('Verdict: HAS_FAILURES');
    expect(r.code).toBe(6);
  });

  it('worker leaves protected files alone: no protected_paths row, all_pass', async () => {
    await setupTask(repoDir, { allowProtected: false });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);

    gitSync('git checkout -b baton/T-0001-test', repoDir);
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'feature.ts'), 'export const feature = 1;\n');
    const baseCommit = gitSync('git rev-parse main', repoDir);
    gitSync('git add -A && git commit -m "worker output"', repoDir);
    const head = gitSync('git rev-parse HEAD', repoDir);
    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), [
      '---',
      'baton_version: 1',
      'task: T-0001',
      'worker: test',
      'branch: baton/T-0001-test',
      `base_commit: ${baseCommit.slice(0, 40)}`,
      `head_commit: ${head.slice(0, 40)}`,
      'claims: []',
      'changed_files:',
      '  - src/feature.ts',
      '---',
      '',
      '## Summary',
      '',
      'Implemented feature.',
      '',
    ].join('\n'));
    gitSync('git add -A && git commit -m "report"', repoDir);

    const r = runBaton(['verify', 'T-0001'], repoDir);
    expect(r.stdout).not.toContain('protected_paths');
    expect(r.stdout).toContain('Verdict: ALL_PASS');
    expect(r.code).toBe(0);
  });

  it('worker-ADDED protected file is removed from the worktree before checks', async () => {
    await setupTask(repoDir, { allowProtected: false, extraFileExistsCheck: true });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    await workerEditsTests(repoDir, { addExtraTest: true });

    const r = runBaton(['verify', 'T-0001'], repoDir);
    // The added test file did not exist at the merge-base — verify strips it
    // from the worktree, so the file_exists(exists:false) check passes.
    expect(r.stdout).toMatch(/no_extra_test\s+file_exists\s+artifact\s+PASS/);
    expect(r.stdout).toMatch(/protected_paths\s+protected\S*\s+hygiene\s+FAIL/);
    expect(r.code).toBe(6);
  });
});
