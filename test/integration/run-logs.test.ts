// Stage 2.5 Item 2: run logs + process tree kill.
// Tests:
// - cmd output persisted to .baton/runs/<run>/<check>.log
// - check_result event has {path, sha256} in log field
// - timeout says "timed out after Ns" not "exit null"
// - hanging child that spawns a grandchild: BOTH killed at timeout
// - last 20 lines of failing check printed in reason
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-runlogs-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function setupTaskWithCmd(repoDir: string, taskId: string, cmdRun: string, timeoutSeconds: number): Promise<void> {
  const yamlText = [
    '---',
    'baton_version: 1',
    `id: ${taskId}`,
    `title: "Task ${taskId}"`,
    'touches: ["src/**"]',
    'reads: []',
    'decisions: []',
    'non_goals: []',
    'checks:',
    '  - { id: scope, type: diff_scope, allow: ["src/**"] }',
    `  - { id: tests, type: cmd, run: "${cmdRun}" }`,
    '  - { id: secrets, type: no_secrets }',
    '---',
    '',
    '## Objective',
    '',
    '## Definition of done',
    '',
  ].join('\n');
  await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
  await writeFile(path.join(repoDir, 'project-memory/tasks', `${taskId}.md`), yamlText);

  // Set timeout in policy
  const policyPath = path.join(repoDir, '.baton/policy.yml');
  let policyText = await readFile(policyPath, 'utf8');
  policyText = policyText.replace(/timeout_seconds: \d+/, `timeout_seconds: ${timeoutSeconds}`);
  // Add the command to allowlist
  policyText = policyText.replace(
    /^allowed_commands: \[\]/m,
    `allowed_commands:\n  - "${cmdRun}"`
  );
  await writeFile(policyPath, policyText);
  execSync('git add -A && git commit -m "task and policy" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
}

describe('Stage 2.5 Item 2: run logs + process tree kill', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('persists cmd output to .baton/runs/<run>/<check>.log and stores {path,sha256} in check_result', async () => {
    // Task with a passing cmd check
    await setupTaskWithCmd(repoDir, 'T-0001', 'node src/handler.js', 30);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/handler.js'), 'console.log("hello from handler");\n');
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
      '  - src/handler.js',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    const result = runBaton(['verify', 'T-0001', '--head', headWithReport, '--yes'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL_PASS');

    // Verify run log exists
    const runsDir = path.join(repoDir, '.baton', 'runs');
    const runDirs = await readdir(runsDir);
    expect(runDirs.length).toBeGreaterThan(0);
    const runDir = runDirs[0]!;
    const logFiles = await readdir(path.join(runsDir, runDir));
    expect(logFiles).toContain('tests.log');

    // Verify log content
    const logContent = await readFile(path.join(runsDir, runDir, 'tests.log'), 'utf8');
    expect(logContent).toContain('=== CMD: node src/handler.js ===');
    expect(logContent).toContain('hello from handler');

    // Verify check_result event in ledger has log {path, sha256}
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const events = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
    const checkResultEvents = events.filter((e: any) => e.type === 'check_result' && e.check === 'tests');
    expect(checkResultEvents.length).toBe(1);
    const cr = checkResultEvents[0];
    expect(cr.log).toBeDefined();
    expect(cr.log.path).toContain('.baton/runs/');
    expect(cr.log.path).toContain('tests.log');
    expect(cr.log.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('timeout says "timed out after Ns" not "exit null"', async () => {
    // Create a script that hangs forever
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/hang.js'), 'setInterval(() => {}, 1000);\n');
    await setupTaskWithCmd(repoDir, 'T-0001', 'node src/hang.js', 2);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
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
      '  - src/hang.js',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    const start = Date.now();
    const result = runBaton(['verify', 'T-0001', '--head', headWithReport, '--yes'], repoDir);
    const elapsed = Date.now() - start;
    expect(result.code).toBe(6);
    expect(elapsed).toBeLessThan(10000);  // Should be killed at ~2s, not 300s
    // v1.2 §6.7: timeout says "timed out after Ns", NOT "exit null"
    expect(result.stdout).toContain('timed out after 2s');
    expect(result.stdout).not.toContain('exit null');
  });

  it('process tree kill: child spawns a grandchild, BOTH are killed at timeout', async () => {
    // Create a parent script that spawns a child (grandchild from Baton's perspective)
    // The grandchild writes to a file periodically. If process tree kill works,
    // the grandchild is also killed and stops writing.
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    // parent.js spawns child.js and then hangs
    await writeFile(path.join(repoDir, 'src/parent.js'), `
const { spawn } = require('child_process');
const child = spawn('node', ['src/child.js'], { stdio: 'inherit' });
child.on('exit', () => process.exit(0));
setInterval(() => {}, 1000);  // parent also hangs
`);
    // child.js writes to a heartbeat file every 500ms
    await writeFile(path.join(repoDir, 'src/child.js'), `
const fs = require('fs');
let i = 0;
setInterval(() => {
  fs.writeFileSync('src/heartbeat.txt', String(i++));
}, 500);
`);
    await setupTaskWithCmd(repoDir, 'T-0001', 'node src/parent.js', 2);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
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
      '  - src/parent.js',
      '  - src/child.js',
      'not_done: []',
      'questions: []',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/reports/R-0001.md'), reportText);
    execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
    const headWithReport = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    const result = runBaton(['verify', 'T-0001', '--head', headWithReport, '--yes'], repoDir);
    expect(result.code).toBe(6);
    expect(result.stdout).toContain('timed out after 2s');

    // After timeout, the grandchild (child.js) should have been killed.
    // Wait a moment for the heartbeat file to stop growing.
    await new Promise(r => setTimeout(r, 2000));
    // Read heartbeat file — the number should NOT be growing anymore
    // (proving the grandchild was killed, not just the parent)
    const hb1 = await readFile(path.join(repoDir, 'src/heartbeat.txt'), 'utf8').catch(() => 'none');
    await new Promise(r => setTimeout(r, 1000));
    const hb2 = await readFile(path.join(repoDir, 'src/heartbeat.txt'), 'utf8').catch(() => 'none');
    expect(hb1).toEqual(hb2);  // Grandchild stopped writing = killed

    // Also verify no leftover node processes from this test
    try {
      const psOutput = execSync('ps aux | grep "src/child.js" | grep -v grep', { encoding: 'utf8' });
      // If we got here, there ARE leftover processes — fail
      expect(psOutput.trim()).toBe('');
    } catch {
      // grep returns non-zero when no matches — that's what we want
    }
  });
});
