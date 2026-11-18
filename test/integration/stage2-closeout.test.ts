// Stage 2 close-out tests:
// - allowed_commands "*" suffix with forbidden chars in args
// - claim dedupe idempotency (run report check twice)
// - block/unblock/unlock
// - standalone report check (independent of verify)
// - golden test: accepted decision bodies appear in packet (T3)
// - --include-files: never_include exclusion + per-file secret scan
// - branch guard: refuses on non-base branch without --allow-branch

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CLI_DIR = '/home/z/my-project/baton-cli';

function runBaton(args: string[], cwd: string, opts: { allowBranch?: boolean } = {}): { stdout: string; stderr: string; code: number } {
  // Auto-append --allow-branch ONLY to ledger-writing commands.
  // init is NOT a ledger-writing command (it doesn't touch ledger.jsonl).
  const ledgerWriteCommands = new Set(['verify', 'accept', 'reject', 'packet', 'report-check', 'decide']);
  const ledgerWriteTaskSubs = new Set(['ready', 'block', 'unblock', 'unlock']);
  let isLedgerWrite = false;
  if (args.length > 0 && ledgerWriteCommands.has(args[0] ?? '')) isLedgerWrite = true;
  if (args.length > 1 && args[0] === 'task' && ledgerWriteTaskSubs.has(args[1] ?? '')) isLedgerWrite = true;
  const finalArgs = (isLedgerWrite && opts.allowBranch !== false) ? [...args, '--allow-branch'] : args;
  // v1.2: task ready blocks on no behavior check — auto-add --allow-weak for tests
  const needsAllowWeak = args.length > 1 && args[0] === 'task' && args[1] === 'ready' && !args.includes('--allow-weak');
  const allArgs = needsAllowWeak ? [...finalArgs, '--allow-weak', 'test allows weak checks'] : finalArgs;
  const quotedArgs = allArgs.map(a => a.includes(' ') ? `"${a}"` : a);
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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-stage2-co-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function setupTaskWithCmd(repoDir: string, taskId: string, allowedCommands: string[], cmdRun: string): Promise<void> {
  const fm = {
    baton_version: 1,
    id: taskId,
    title: `Task ${taskId}`,
    touches: ['src/**'],
    reads: [],
    decisions: [],
    non_goals: [],
    checks: [
      { id: 'scope', type: 'diff_scope', allow: ['src/**'] },
      { id: 'tests', type: 'cmd', run: cmdRun, covers: ['api.status'] },
      { id: 'secrets', type: 'no_secrets' },
    ],
  };
  const yamlText = [
    '---',
    `baton_version: 1`,
    `id: ${taskId}`,
    `title: "Task ${taskId}"`,
    `touches: ["src/**"]`,
    `reads: []`,
    `decisions: []`,
    `non_goals: []`,
    `checks:`,
    `  - { id: scope, type: diff_scope, allow: ["src/**"] }`,
    `  - { id: tests, type: cmd, run: "${cmdRun}", covers: ["api.status"] }`,
    `  - { id: secrets, type: no_secrets }`,
    '---',
    '',
    '## Objective',
    '',
    '## Definition of done',
    '',
  ].join('\n');
  await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
  await writeFile(path.join(repoDir, 'project-memory/tasks', `${taskId}.md`), yamlText);
  execSync('git add -A && git commit -m "task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

  // Update policy with allowed commands
  const policyPath = path.join(repoDir, '.baton/policy.yml');
  const policyText = await readFile(policyPath, 'utf8');
  const updated = policyText.replace(
    /^allowed_commands: \[\]/m,
    `allowed_commands:\n${allowedCommands.map(c => `  - "${c}"`).join('\n')}`
  );
  await writeFile(policyPath, updated);
  execSync('git add -A && git commit -m "policy" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
}

describe('Stage 2 close-out: spec items 2-5', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('allowed_commands " *" suffix: rejects args with forbidden chars', async () => {
    // Policy allows "node *" — any args. But args with ; & | < > $ ( ) etc. must be rejected.
    // The check at task ready time should catch this. The check at run time also catches.
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    // This command should be valid (no forbidden chars)
    const ready = runBaton(['task', 'ready', 'T-0001'], repoDir);
    expect(ready.code).toBe(0);

    // Now try a command with forbidden chars (semicolon)
    const badTaskFm = [
      '---',
      'baton_version: 1',
      'id: T-0002',
      'title: "Bad task"',
      'touches: ["src/**"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: tests, type: cmd, run: "node --version; rm -rf /" }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0002.md'), badTaskFm);
    execSync('git add -A && git commit -m "bad task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    const badReady = runBaton(['task', 'ready', 'T-0002'], repoDir);
    expect(badReady.code).not.toBe(0);
    expect(badReady.stderr).toContain('forbidden');
  });

  it('claim dedupe idempotency: running report check twice produces no duplicate claims', async () => {
    // Setup task + report
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Create worker branch with code + report
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
      'claims:',
      '  - { statement: "Handler exports x", key: api.handler, evidence: "src/handler.ts" }',
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

    // First report check
    const r1 = runBaton(['report-check', 'project-memory/reports/R-0001.md'], repoDir);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain('claims added: 1');

    // Second report check — should not add duplicate
    const r2 = runBaton(['report-check', 'project-memory/reports/R-0001.md'], repoDir);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('claims added: 0');

    // Verify ledger has exactly 1 claim event
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const claimEvents = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).filter((e: any) => e.type === 'claim');
    expect(claimEvents.length).toBe(1);
  });

  it('block / unblock / unlock cycle (P0-2 prior_status)', async () => {
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    // Commit ledger changes from task ready
    execSync('git add -A && git commit -m "ready" --allow-empty --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Block (status was 'ready')
    const block = runBaton(['task', 'block', 'T-0001', '--reason', 'waiting on vendor'], repoDir);
    expect(block.code).toBe(0);
    expect(block.stdout).toContain('prior status: ready');

    // Verify status via task list
    const list1 = runBaton(['task', 'list'], repoDir);
    expect(list1.stdout).toContain('blocked');

    // Unblock (restores to 'ready')
    const unblock = runBaton(['task', 'unblock', 'T-0001', '--reason', 'vendor replied'], repoDir);
    expect(unblock.code).toBe(0);
    expect(unblock.stdout).toContain('restored to: ready');

    const list2 = runBaton(['task', 'list'], repoDir);
    expect(list2.stdout).toContain('ready');

    // Unlock (returns to draft)
    const unlock = runBaton(['task', 'unlock', 'T-0001', '--reason', 'need to fix checks'], repoDir);
    expect(unlock.code).toBe(0);
    expect(unlock.stdout).toContain('unlocked');

    const list3 = runBaton(['task', 'list'], repoDir);
    expect(list3.stdout).toContain('draft');
  });

  it('standalone report check works independently of verify', async () => {
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
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

    // Run standalone report check (NOT verify)
    const r = runBaton(['report-check', 'project-memory/reports/R-0001.md'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('VALID');
    expect(r.stdout).toContain('sha:');
  });

  it('golden test: accepted decision bodies appear in packet (T3)', async () => {
    // Create decision with body text inline (P0-3: body must be set at proposed time)
    runBaton([
      'decide', 'Use picomatch for globs',
      '--key', 'core.globs',
      '--areas', 'src/**',
      '--decision', 'Use picomatch 4.x with dot:true for all glob matching.',
      '--why', 'picomatch is fast, handles POSIX + Windows paths, and supports dotfile matching.',
      '--alternatives', '- minimatch: slower, less maintained',
    ], repoDir);
    execSync('git add -A && git commit -m "decision with body" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['decide', 'accept', 'D-0001'], repoDir);
    execSync('git add -A && git commit -m "accepted" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Create task that touches src/ (overlaps with decision areas)
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Implement globs"',
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

    // Compile packet
    const packetResult = runBaton(['packet', 'T-0001'], repoDir);
    expect(packetResult.code).toBe(0);

    // Read the packet file
    const packetText = await readFile(path.join(repoDir, 'project-memory/packets/T-0001.md'), 'utf8');
    // Golden assertions:
    // 1. Decision D-0001 is mentioned
    expect(packetText).toContain('D-0001');
    // 2. The decision body text appears (proves body was loaded, not just metadata)
    expect(packetText).toContain('picomatch 4.x');
    expect(packetText).toContain('dot:true');
    // 3. The "Why" reasoning appears
    expect(packetText).toContain('fast, handles POSIX');
  });

  it('--include-files: skips never_include files and files with secrets', async () => {
    // Create task touching files including .env and a file with secrets
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Test include-files"',
      'touches: ["src/**", ".env*"]',
      'reads: []',
      'decisions: []',
      'non_goals: []',
      'checks:',
      '  - { id: scope, type: diff_scope, allow: ["src/**", ".env*"] }',
      '  - { id: secrets, type: no_secrets }',
      '---',
      '',
      '## Objective',
      '',
      '## Definition of done',
      '',
    ].join('\n');
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);

    // Create safe source file
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/handler.ts'), 'export const x = 1;\n');

    // Create .env file (should be excluded by never_include)
    await writeFile(path.join(repoDir, '.env'), 'SECRET_KEY=should_not_appear\n');

    // Create file with secret pattern (should be excluded by per-file scan)
    await mkdir(path.join(repoDir, 'src/config'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/config/creds.ts'), 'export const KEY = "AKIATESTTESTTEST1234";\n');

    execSync('git add -A && git commit -m "setup" --allow-empty', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    const r = runBaton(['packet', 'T-0001', '--include-files'], repoDir);
    expect(r.code).toBe(0);

    const packetText = await readFile(path.join(repoDir, 'project-memory/packets/T-0001.md'), 'utf8');
    // Safe file content is included
    expect(packetText).toContain('export const x = 1');
    // .env is excluded
    expect(packetText).not.toContain('SECRET_KEY=should_not_appear');
    // File with AKIA pattern is excluded
    expect(packetText).not.toContain('AKIATESTTESTTEST1234');
  });

  it('branch guard: refuses on non-base branch without --allow-branch', async () => {
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Switch to non-base branch
    execSync('git checkout -b feature/other', { cwd: repoDir, stdio: 'pipe' });

    // Try to run packet without --allow-branch
    const r = runBaton(['packet', 'T-0001'], repoDir, { allowBranch: false });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('refused');
    expect(r.stderr).toContain('feature/other');
    expect(r.stderr).toContain('Override with --allow-branch');
  });

  it('branch guard: --allow-branch permits on non-base branch', async () => {
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b feature/other', { cwd: repoDir, stdio: 'pipe' });
    // With --allow-branch (auto-added by test helper unless allowBranch: false)
    const r = runBaton(['packet', 'T-0001'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Packet for T-0001');
  });
});

describe('Stage 2.5 Item 6: task ready blocks + --allow-weak + report check exits 6', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('task ready BLOCKS (exit 4) when no behavior or interface check', async () => {
    // Task with only hygiene checks (scope + secrets) — no cmd or contract
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Doc only"',
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
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    execSync('git add -A && git commit -m "task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // task ready should BLOCK with exit 4
    // Use a version of runBaton that does NOT auto-add --allow-weak
    const result = runBaton(['task', 'ready', 'T-0001', '--no-allow-weak'], repoDir);
    // Actually we can't easily pass --no-allow-weak since the helper auto-adds.
    // Instead, call the CLI directly:
    const directResult = (() => {
      try {
        const stdout = execSync(`npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} task ready T-0001 --allow-branch`, {
          cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
        });
        return { stdout, stderr: '', code: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
      }
    })();
    expect(directResult.code).toBe(4);
    expect(directResult.stderr).toContain('blocked');
    expect(directResult.stderr).toContain('no behavior');
    expect(directResult.stderr).toContain('--allow-weak');
  });

  it('--allow-weak "<reason>" overrides the block and is recorded in task_locked', async () => {
    const taskText = [
      '---',
      'baton_version: 1',
      'id: T-0001',
      'title: "Doc only"',
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
    await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
    await writeFile(path.join(repoDir, 'project-memory/tasks/T-0001.md'), taskText);
    execSync('git add -A && git commit -m "task" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    // Use --allow-weak with a reason
    const directResult = (() => {
      try {
        const stdout = execSync(`npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} task ready T-0001 --allow-branch --allow-weak "documentation-only task"`, {
          cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
        });
        return { stdout, stderr: '', code: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
      }
    })();
    expect(directResult.code).toBe(0);
    expect(directResult.stdout).toContain('Task T-0001 locked');
    expect(directResult.stdout).toContain('weak checks allowed: documentation-only task');

    // Verify the allow_weak reason is recorded in the ledger
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const lockedEvent = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).find((e: any) => e.type === 'task_locked');
    expect(lockedEvent).toBeDefined();
    expect(lockedEvent.allow_weak).toBe('documentation-only task');
  });

  it('report check always exits 6 on mismatch (no --strict flag)', async () => {
    // Create a task with cmd check so it can be locked without --allow-weak
    await setupTaskWithCmd(repoDir, 'T-0001', ['node *'], 'node --version');
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready" --allow-empty', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/handler.ts'), 'export const x = 1;\n');
    await mkdir(path.join(repoDir, 'migrations'), { recursive: true });
    await writeFile(path.join(repoDir, 'migrations/0001.sql'), 'CREATE TABLE users;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker"', { cwd: repoDir, stdio: 'pipe' });
    const workerHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Report LIES: claims only src/handler.ts, omits migrations/0001.sql
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
    execSync(`git checkout baton/T-0001-test -- project-memory/reports/R-0001.md`, { cwd: repoDir, stdio: 'pipe' });

    // report-check should exit 6 (no --strict needed)
    const r = runBaton(['report-check', 'project-memory/reports/R-0001.md'], repoDir);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('report check failed');
    expect(r.stderr).toContain('missing 1 files in report');
  });
});
