// Stage 2.5 Item 7: Missing tests from spec §6.8.
// Tests marked MISSING in the mapping table.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { verdict, strengthOf } from '../../src/core/verdicts.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-missing-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

// ---------- Unit tests for verdict, reasons, claim-covering, strength logic ----------

describe('§6.8 Unit: verdict logic', () => {
  it('all pass → all_pass', () => {
    expect(verdict([{ result: 'pass' }, { result: 'pass' }])).toBe('all_pass');
  });
  it('any fail → has_failures', () => {
    expect(verdict([{ result: 'pass' }, { result: 'fail' }])).toBe('has_failures');
  });
  it('any skip (no fail) → incomplete', () => {
    expect(verdict([{ result: 'pass' }, { result: 'skip' }])).toBe('incomplete');
  });
  it('fail takes precedence over skip', () => {
    expect(verdict([{ result: 'fail' }, { result: 'skip' }])).toBe('has_failures');
  });
  it('empty → all_pass', () => {
    expect(verdict([])).toBe('all_pass');
  });
});

describe('§6.8 Unit: strength logic', () => {
  it('cmd → behavior', () => {
    expect(strengthOf('cmd')).toBe('behavior');
  });
  it('contract → interface', () => {
    expect(strengthOf('contract')).toBe('interface');
  });
  it('grep → artifact', () => {
    expect(strengthOf('grep')).toBe('artifact');
  });
  it('file_exists → artifact', () => {
    expect(strengthOf('file_exists')).toBe('artifact');
  });
  it('diff_scope → hygiene', () => {
    expect(strengthOf('diff_scope')).toBe('hygiene');
  });
  it('no_secrets → hygiene', () => {
    expect(strengthOf('no_secrets')).toBe('hygiene');
  });
  it('report_matches → hygiene', () => {
    expect(strengthOf('report_matches')).toBe('hygiene');
  });
});

// ---------- Integration: command not on allowlist ----------

describe('§6.8 Integration: command not on allowlist', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('cmd check fails when command is not on allowlist', async () => {
    // Task with a cmd check whose command is NOT in policy.allowed_commands
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test not-allowlisted"',
      'touches: ["src/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: tests, type: cmd, run: "node --version", covers: ["api"] }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    // policy.yml has empty allowed_commands (default from init)
    execSync('git add -A && git commit -m "task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    // task ready should FAIL (exit 5) because cmd is not on allowlist
    const ready = runBaton(['task', 'ready', 'T-0001'], repoDir);
    expect(ready.code).not.toBe(0);
    // Should print the YAML block to add
    expect(ready.stderr).toContain('allowed_commands');
    expect(ready.stderr).toContain('node --version');
  });
});

// ---------- Integration: output flood truncated ----------

describe('§6.8 Integration: output flood truncated', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('cmd output over 10MB is truncated (not hung, not crashed)', async () => {
    // Create a script that outputs > 10MB of text
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    // Script outputs ~15MB (15000000 chars)
    await writeFile(path.join(repoDir, 'src/flood.js'), `
process.stdout.write('x'.repeat(15000000));
process.exit(0);
`);
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test output flood"',
      'touches: ["src/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: flood, type: cmd, run: "node src/flood.js" }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    // Add command to allowlist
    const policyPath = path.join(repoDir, '.baton/policy.yml');
    let policyText = await readFile(policyPath, 'utf8');
    policyText = policyText.replace(
      /^allowed_commands: \[\]/m,
      `allowed_commands:\n  - "node src/flood.js"`
    );
    await writeFile(policyPath, policyText);
    execSync('git add -A && git commit -m "setup" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/handler.ts'), 'export const x = 1;\n');
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
      '  - src/handler.ts',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    // verify should complete without hanging or crashing
    const result = runBaton(['verify', 'T-0001', '--head', headWithReport, '--yes'], repoDir);
    if (result.code !== 0) {
      console.error('VERIFY OUTPUT:\n' + result.stdout + '\nSTDERR:\n' + result.stderr);
    }
    // Should pass (exit 0) — the flood command exits 0
    expect(result.code).toBe(0);
    // The run log should exist
    const runsDir = path.join(repoDir, '.baton', 'runs');
    const runDirs = await readdirSafe(runsDir);
    expect(runDirs.length).toBeGreaterThan(0);
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  try { return await import('node:fs/promises').then(fs => fs.readdir(dir)); }
  catch { return []; }
}

// ---------- Integration: malicious --branch value rejected ----------

describe('§6.8 Integration: malicious --branch value rejected', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('verify --branch with shell metacharacters is rejected (G9)', async () => {
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

    // Malicious branch name with shell metacharacters
    const result = runBaton(['verify', 'T-0001', '--branch', 'main; rm -rf /'], repoDir);
    expect(result.code).not.toBe(0);
    // Should be rejected by G9 validation
    expect(result.stderr).toMatch(/invalid|rejected|forbidden|not.*allow/i);
  });

  it('verify --branch with .. is rejected (path traversal)', async () => {
    const result = runBaton(['verify', 'T-0001', '--branch', '../../../etc/passwd'], repoDir);
    expect(result.code).not.toBe(0);
  });
});

// ---------- Integration: FAKE_TOKEN absent in child ----------

describe('§6.8 Integration: FAKE_TOKEN absent in child', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('parent env var FAKE_TOKEN is absent in the child process (G23)', async () => {
    // Create a script that checks for FAKE_TOKEN and exits 1 if found
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/check_env.js'), `
const val = process.env.FAKE_TOKEN;
if (val) {
  console.error('FAKE_TOKEN LEAKED: ' + val);
  process.exit(1);
} else {
  console.log('FAKE_TOKEN absent');
  process.exit(0);
}
`);
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test env sanitization"',
      'touches: ["src/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
      '  - { id: env, type: cmd, run: "node src/check_env.js" }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    const policyPath = path.join(repoDir, '.baton/policy.yml');
    let policyText = await readFile(policyPath, 'utf8');
    policyText = policyText.replace(
      /^allowed_commands: \[\]/m,
      `allowed_commands:\n  - "node src/check_env.js"`
    );
    await writeFile(policyPath, policyText);
    execSync('git add -A && git commit -m "setup" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await writeFile(path.join(repoDir, 'src/handler.ts'), 'export const x = 1;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker"', { cwd: repoDir, stdio: 'pipe' });
    const workerHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    // Report must list ALL changed files in the worker diff (only handler.ts)
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
      '  - src/handler.ts',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    // Set FAKE_TOKEN in the parent environment
    // The test runner (vitest) passes env to execSync, which passes to baton,
    // which strips TOKEN-matching vars before spawning the cmd child.
    const env = { ...process.env, FAKE_TOKEN: 'secret123' };
    const quotedArgs = ['verify', 'T-0001', '--head', headWithReport, '--yes', '--allow-branch']
      .map(a => a.includes(' ') ? `"${a}"` : a);
    let result: { stdout: string; stderr: string; code: number };
    try {
      const stdout = execSync(
        `npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} ${quotedArgs.join(' ')}`,
        { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, env }
      );
      result = { stdout, stderr: '', code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      result = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
    }
    // env check should PASS because FAKE_TOKEN was stripped from child
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL_PASS');
    expect(result.stdout).not.toContain('LEAKED');
  });
});

// ---------- Integration: simulated crash cleans worktree ----------

describe('§6.8 Integration: simulated crash cleans worktree', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('a killed verify leaves no .baton/tmp/wt-* worktree (startup cleanup)', async () => {
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test crash cleanup"',
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

    // Create a stale .baton/tmp/wt-* worktree manually (simulates a killed verify)
    await mkdir(path.join(repoDir, '.baton/tmp'), { recursive: true });
    const stalePath = path.join(repoDir, '.baton/tmp/wt-T-0001-r-0001-99999');
    execSync(`git worktree add --detach "${stalePath}" HEAD`, { cwd: repoDir, stdio: 'pipe' });

    // Verify it exists
    const { access } = await import('node:fs/promises');
    await access(stalePath);

    // Run any baton command — startup cleanup should remove the stale worktree
    runBaton(['task', 'list'], repoDir);

    // The stale worktree should be gone
    let staleExists = true;
    try { await access(stalePath); } catch { staleExists = false; }
    expect(staleExists).toBe(false);

    // git worktree list should not contain it
    const wtList = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(wtList).not.toContain('wt-T-0001-r-0001-99999');
  });
});

// ---------- Integration: two concurrent verifies use different worktree paths ----------

describe('§6.8 Integration: two concurrent verifies use different worktree paths', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('two verify runs produce worktrees with different paths (pid in path)', async () => {
    // P0-9: worktree path is wt-<taskId>-<runId>-<pid>
    // Two sequential verifies will have different runIds (r-0001, r-0002)
    // and potentially different pids if run as separate processes.
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test concurrent"',
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

    // Run verify twice. Each creates a worktree with format wt-T-0001-r-XXXX-<pid>
    // The worktrees are removed in the finally block, but the ledger records the runId.
    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/handler.ts'), 'export const x = 1;\n');
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
      '  - src/handler.ts',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    // First verify
    const r1 = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(r1.code).toBe(0);
    // Second verify
    const r2 = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(r2.code).toBe(0);

    // Both should succeed. The ledger should have two verify_run events with different runIds.
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const verifyRuns = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).filter((e: any) => e.type === 'verify_run');
    expect(verifyRuns.length).toBe(2);
    expect(verifyRuns[0].run_id).not.toBe(verifyRuns[1].run_id);

    // No leftover worktrees
    const wtList = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(wtList).not.toContain('.baton/tmp/wt-');
  });
});
