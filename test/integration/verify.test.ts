// Stage 2 integration tests: verify catches bad work.
// Per spec §6.10 manual acceptance: "Branch B also edits a migration file outside scope
// and claims 'no other files touched': exits 6 with scope and report_matches failing."
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  // Quote any arg containing spaces so commander parses it as a single value.
  // Auto-append --allow-branch to ledger-writing commands when not on main.
  // Tests that explicitly need branch-guard failures will pass --no-allow-branch via args.
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
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-stage2-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function setupTask(repoDir: string, taskId: string, touches: string[], checks: any[]): Promise<void> {
  // Write a task file directly with custom checks
  const fm = {
    baton_version: 1,
    id: taskId,
    title: `Task ${taskId}`,
    touches,
    reads: [],
    decisions: [],
    non_goals: [],
    checks,
  };
  const yamlText = [
    '---',
    `baton_version: 1`,
    `id: ${taskId}`,
    `title: "Task ${taskId}"`,
    `touches: [${touches.map(t => `"${t}"`).join(', ')}]`,
    `reads: []`,
    `decisions: []`,
    `non_goals: []`,
    `checks:`,
    ...checks.map(c => `  - { id: ${c.id}, type: ${c.type}${c.allow ? `, allow: [${c.allow.map((a:string)=>`"${a}"`).join(', ')}]` : ''}${c.run ? `, run: "${c.run}"` : ''}${c.description ? `, description: "${c.description}"` : ''} }`),
    '---',
    '',
    '## Objective',
    '',
    '## Definition of done',
    '',
  ].join('\n');
  await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
  await writeFile(path.join(repoDir, 'project-memory/tasks', `${taskId}.md`), yamlText);
  execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
}

describe('Stage 2: verify engine', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('verify catches scope creep — worker edits file outside allow', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/api/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/api/**'], description: 'only src/api may change' },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    // Commit the ledger changes from task ready before branching
    execSync('git add -A && git commit -m "task ready"', { cwd: repoDir, stdio: 'pipe' });

    // Create worker branch with in-scope + out-of-scope changes
    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await mkdir(path.join(repoDir, 'migrations'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    await writeFile(path.join(repoDir, 'migrations/0001_add_users.sql'), '-- migration\n');

    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
    const head = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Write a report that LIES about changed_files (claims only in-scope file)
    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    const reportText = [
      '---',
      'baton_version: 1',
      'task: T-0001',
      'worker: test',
      'branch: baton/T-0001-test',
      `base_commit: ${baseCommit}`,
      `head_commit: ${head}`,
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

    const result = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(result.code).toBe(6);
    expect(result.stdout).toContain('HAS_FAILURES');
    expect(result.stdout).toContain('scope');
    expect(result.stdout).toContain('FAIL');
    expect(result.stdout).toContain('report_matches');
    expect(result.stdout).toContain('migrations');
  });

  it('verify rejects missing report (P0-7: fail not skip)', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/api/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/api/**'] },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "task ready"', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
    const head = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // No report written — should fail (P0-7)
    const result = runBaton(['verify', 'T-0001', '--head', head], repoDir);
    expect(result.code).toBe(6);
    expect(result.stdout).toContain('HAS_FAILURES');
    expect(result.stdout).toContain('no report');
  });

  it('accept works after verify all_pass', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/api/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/api/**'], description: 'src/api only' },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "task ready"', { cwd: repoDir, stdio: 'pipe' });

    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    // Worker commits code AND report in ONE commit (no amend, no chicken-and-egg)
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    // We don't know the head yet — use a placeholder, then read the head from git after commit
    // and verify with --head pointing to that commit. The report's head_commit will mismatch,
    // but the lenient check accepts ancestry: report.head_commit's parent IS the worker commit.
    // Simpler approach: commit code first, then commit report on top. Use the worker commit as --head
    // AND verify that the report exists at the LATEST commit (we read report from `head` ref).
    // Actually: the verify code uses fileExistsAtRef(head, ...) — so report must exist at head.
    // The cleanest workflow: commit code + report in one commit, then --head = that commit.
    // The report's head_commit can be set to the actual commit hash after commit.
    // But hash depends on content. Use this trick: write report with empty head_commit,
    // commit, read hash, update head_commit, amend. The amend changes hash but the lenient
    // ancestry check accepts it (old head IS an ancestor of amended head — they share the parent).
    // Actually NO: amend REPLACES the commit, the old hash is dangling not an ancestor.
    //
    // Simplest correct flow:
    //   1. Commit code (worker commit)
    //   2. Write report with head_commit = worker commit hash
    //   3. Commit report as a NEW commit on top
    //   4. --head = the report commit (latest)
    //   5. report.head_commit = worker commit (parent of head)
    //   6. check: report.head_commit is ancestor of head? YES (parent)
    execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
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

    const verifyResult = runBaton(['verify', 'T-0001', '--head', headWithReport], repoDir);
    expect(verifyResult.code).toBe(0);
    expect(verifyResult.stdout).toContain('ALL_PASS');

    const acceptResult = runBaton(['accept', 'T-0001'], repoDir);
    expect(acceptResult.code).toBe(0);
    expect(acceptResult.stdout).toContain('accepted');
  });

  it('reject with --follow-up creates follow-up task (P0-11)', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/api/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/api/**'] },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);

    const rejectResult = runBaton(['reject', 'T-0001', '--reason', 'bad implementation', '--follow-up', 'Redo with correct approach'], repoDir);
    expect(rejectResult.code).toBe(0);
    expect(rejectResult.stdout).toContain('Follow-up task created: T-0002');

    // Verify follow-up task exists
    const followUpPath = path.join(repoDir, 'project-memory/tasks/T-0002.md');
    const text = await readFile(followUpPath, 'utf8');
    expect(text).toContain('Redo with correct approach');

    // Verify ledger has follow_up_task field (P0-11)
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const rejectEvent = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).find((e: any) => e.type === 'rejected');
    expect(rejectEvent).toBeDefined();
    expect(rejectEvent.follow_up_task).toBe('T-0002');
  });

  it('block/unblock preserves prior_status (P0-2)', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/**'] },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);

    // Block the task (status was 'ready')
    const blockResult = runBaton(['task', 'block', 'T-0001', '--reason', 'waiting on vendor'], repoDir);
    expect(blockResult.code).toBe(0);
    expect(blockResult.stdout).toContain('prior status: ready');

    // Unblock should restore to 'ready'
    const unblockResult = runBaton(['task', 'unblock', 'T-0001', '--reason', 'vendor replied'], repoDir);
    expect(unblockResult.code).toBe(0);
    expect(unblockResult.stdout).toContain('restored to: ready');

    // Verify ledger has prior_status field (P0-2)
    const ledger = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const blockedEvent = ledger.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).find((e: any) => e.type === 'blocked');
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent.prior_status).toBe('ready');
  });

  it('verify reads task from base branch — worker edits to task file are ignored (G17)', async () => {
    runBaton(['init'], repoDir);
    await setupTask(repoDir, 'T-0001', ['src/api/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/api/**'] },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "task ready"', { cwd: repoDir, stdio: 'pipe' });

    // Worker creates branch and edits the task file (tries to remove a check)
    execSync('git checkout -b baton/T-0001-test', { cwd: repoDir, stdio: 'pipe' });
    const taskPath = path.join(repoDir, 'project-memory/tasks/T-0001.md');
    const taskText = await readFile(taskPath, 'utf8');
    const modified = taskText.replace('- { id: secrets, type: no_secrets }', '');
    await writeFile(taskPath, modified);
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handler.ts'), 'export const x = 1;\n');
    const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
    execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
    const head = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Write honest report (lists only the in-scope file)
    await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
    const reportText = [
      '---',
      'baton_version: 1',
      'task: T-0001',
      'worker: test',
      'branch: baton/T-0001-test',
      `base_commit: ${baseCommit}`,
      `head_commit: ${head}`,
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
    const headFinal = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Verify should detect scope creep: the worker edited project-memory/tasks/T-0001.md
    // which is in the always-denied list. The verify reads the task from BASE branch
    // (so worker's edit to remove check is ignored), but diff_scope catches the file change.
    const result = runBaton(['verify', 'T-0001', '--head', headFinal], repoDir);
    expect(result.code).toBe(6);
    expect(result.stdout).toContain('HAS_FAILURES');
    // The worker's edit to tasks/T-0001.md should trip diff_scope (denied path not in allow)
    expect(result.stdout).toContain('scope');
    expect(result.stdout).toContain('FAIL');
  });
});
