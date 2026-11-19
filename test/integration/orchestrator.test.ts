// v1.3 integration: orchestrator core.
// - baton next: deterministic scheduling with dependency + area-conflict rules
// - baton reject x2: automatic escalation
// - baton done: Definition of Done gate (exit 1 while work pending)
// - baton workers: reputation derived from report front matter + ledger
// - full lifecycle: ready -> packet -> worker branch -> verify -> accept -> done exits 0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CLI_DIR = '/home/z/my-project/baton-cli';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-orch-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function setupTask(
  repoDir: string,
  taskId: string,
  touches: string[],
  dependsOn: string[] = [],
): Promise<void> {
  const fm = [
    '---',
    'baton_version: 1',
    `id: ${taskId}`,
    `title: "Task ${taskId}"`,
    `touches: [${touches.map(t => `"${t}"`).join(', ')}]`,
    'reads: []',
    'decisions: []',
    'non_goals: []',
    ...(dependsOn.length > 0 ? [`depends_on: [${dependsOn.map(d => `"${d}"`).join(', ')}]`] : []),
    'checks:',
    `  - { id: scope, type: diff_scope, allow: [${touches.map(t => `"${t}"`).join(', ')}], description: "only task area may change" }`,
    '  - { id: secrets, type: no_secrets }',
    '---',
    '',
    '## Objective',
    '',
    '## Definition of done',
    '',
  ].join('\n');
  await mkdir(path.join(repoDir, 'project-memory/tasks'), { recursive: true });
  await writeFile(path.join(repoDir, 'project-memory/tasks', `${taskId}.md`), fm);
}

async function makeWorkerBranchWithReport(
  repoDir: string,
  taskId: string,
  slug: string,
  workerName: string,
  dirName: string,
): Promise<string> {
  execSync(`git checkout -b baton/${taskId}-${slug}`, { cwd: repoDir, stdio: 'pipe' });
  await mkdir(path.join(repoDir, dirName), { recursive: true });
  await writeFile(path.join(repoDir, dirName, 'impl.ts'), `// ${taskId} implementation\nexport const ok = true;\n`);

  const baseCommit = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
  execSync('git add -A && git commit -m "worker output"', { cwd: repoDir, stdio: 'pipe' });
  const codeHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

  // Report head_commit points at the worker-output commit; the report commit itself
  // sits on top (check-engine accepts ancestors of the verified head).
  await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
  const reportText = [
    '---',
    'baton_version: 1',
    `task: ${taskId}`,
    `worker: ${workerName}`,
    `branch: baton/${taskId}-${slug}`,
    `base_commit: ${baseCommit}`,
    `head_commit: ${codeHead}`,
    'claims:',
    `  - statement: "${taskId} implemented and committed"`,
    'changed_files:',
    `  - ${dirName}/impl.ts`,
    '---',
    '',
    '## Report',
    '',
    'Done.',
    '',
  ].join('\n');
  await writeFile(path.join(repoDir, 'project-memory/reports', `R-${slug}.md`), reportText);
  execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
  const head = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
  execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
  execSync(`git checkout baton/${taskId}-${slug} -- project-memory/reports/R-${slug}.md`, { cwd: repoDir, stdio: 'pipe' });
  return head;
}

describe('v1.3 orchestrator core', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('next schedules ready tasks in order and skips area-conflicted ones', async () => {
    await setupTask(repoDir, 'T-0001', ['src/api/**']);
    await setupTask(repoDir, 'T-0002', ['src/web/**']);
    execSync('git add -A && git commit -m "tasks"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    runBaton(['task', 'ready', 'T-0002'], repoDir);
    execSync('git add -A && git commit -m "ready"', { cwd: repoDir, stdio: 'pipe' });

    const n1 = runBaton(['next'], repoDir);
    expect(n1.code).toBe(0);
    expect(n1.stdout).toContain('NEXT: T-0001');

    // Dispatch T-0001 (packet issue -> assigned -> its area is reserved)
    runBaton(['packet', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "packet"', { cwd: repoDir, stdio: 'pipe' });

    const n2 = runBaton(['next'], repoDir);
    expect(n2.code).toBe(0);
    expect(n2.stdout).toContain('NEXT: T-0002');
    expect(n2.stdout).toContain('T-0001'); // in-flight listing
  });

  it('next respects dependencies and reports blockers', async () => {
    await setupTask(repoDir, 'T-0001', ['src/api/**']);
    await setupTask(repoDir, 'T-0002', ['src/web/**'], ['T-0001']);
    execSync('git add -A && git commit -m "tasks"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    runBaton(['task', 'ready', 'T-0002'], repoDir);
    execSync('git add -A && git commit -m "ready"', { cwd: repoDir, stdio: 'pipe' });

    // Dispatch T-0001 — T-0002 has no overlap but depends on T-0001 (not done)
    runBaton(['packet', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "packet"', { cwd: repoDir, stdio: 'pipe' });

    const n = runBaton(['next'], repoDir);
    expect(n.code).toBe(1); // nothing eligible
    expect(n.stdout).toContain('No eligible task right now');
    expect(n.stdout).toContain('Waiting on dependencies');
    expect(n.stdout).toContain('T-0002');
  });

  it('two rejections escalate the task; done reports it', async () => {
    await setupTask(repoDir, 'T-0001', ['src/api/**']);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready"', { cwd: repoDir, stdio: 'pipe' });

    // reject requires ledger-known task — the task is locked (ready), fine
    const r1 = runBaton(['reject', 'T-0001', '--reason', 'scope creep'], repoDir);
    expect(r1.code).toBe(0);
    expect(r1.stdout).not.toContain('ESCALATED');

    const r2 = runBaton(['reject', 'T-0001', '--reason', 'tests still failing'], repoDir);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('ESCALATED');
    expect(r2.stdout).toContain('2 rejections');

    const d = runBaton(['done'], repoDir);
    expect(d.code).toBe(1);
    expect(d.stdout).toContain('NOT DONE');
    expect(d.stdout).toContain('ESCALATED');
    expect(d.stdout).toContain('T-0001');

    const dl = runBaton(['task', 'list'], repoDir);
    expect(dl.stdout).toContain('rejected');
  });

  it('workers derives reputation from report front matter + ledger outcomes', async () => {
    await setupTask(repoDir, 'T-0001', ['src/api/**']);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "ready"', { cwd: repoDir, stdio: 'pipe' });

    // Worker A does the work, verify passes, accepted
    const head = await makeWorkerBranchWithReport(repoDir, 'T-0001', '0001', 'alpha-agent', 'src/api');
    const v = runBaton(['verify', 'T-0001', '--branch', 'baton/T-0001-0001', '--head', head, '--yes'], repoDir);
    expect(v.code).toBe(0);
    const a = runBaton(['accept', 'T-0001'], repoDir);
    expect(a.code).toBe(0);

    const w = runBaton(['workers'], repoDir);
    expect(w.code).toBe(0);
    expect(w.stdout).toContain('alpha-agent');
    expect(w.stdout).toContain('accepted 1');

    // done should now be satisfied (only task, accepted; doctor clean)
    const d = runBaton(['done'], repoDir);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain('PROJECT DONE');
  });

  it('done exits 0 on a fresh repo (no tasks at all)', () => {
    const d = runBaton(['done'], repoDir);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain('PROJECT DONE');
  });
});
