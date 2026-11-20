// Shared integration-test helpers.
// v1.3.2 (P3-5): extracted from the per-file copies so they stop drifting.
// The runner still uses npx tsx src/cli.ts; the dist switch + cached template
// fixture land with the test-speed item.
import { execSync } from 'node:child_process';
import { existsSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// test/helpers.ts lives one level below the CLI root (unlike the per-file
// helpers in test/integration/, which need '../..').
export const CLI_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * v1.3.2 P3 (test speed): prefer the built dist/cli.js (fast node startup over
 * a per-spawn tsx compile). Falls back to npx tsx src/cli.ts when no build
 * exists, so tests still run without one.
 */

/**
 * v1.3.2 P3 (test speed): cached template git fixture. Built ONCE per machine
 * (keyed into tmpdir), then cloned per test — a clone is ~30ms vs ~1.5s for
 * git init + baton init + scaffold commit. The template contains exactly what
 * makeTempRepo + runBaton(['init']) + scaffold commit produce.
 */
// Keyed by CLI version so a CLI update invalidates the cached scaffold.
const TEMPLATE_VERSION = 'v' + (JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8') as string).version as string);
const TEMPLATE_DIR = path.join(tmpdir(), 'baton-fixture-template-' + TEMPLATE_VERSION);
let templateReady: Promise<string> | null = null;

function getTemplate(): Promise<string> {
  if (!templateReady) {
    templateReady = (async () => {
      // Cache hit — template already built (possibly by another worker)
      if (existsSync(path.join(TEMPLATE_DIR, '.baton-fixture-ok'))) {
        return TEMPLATE_DIR;
      }
      const stagingDir = await mkdtemp(path.join(tmpdir(), 'baton-fixture-build-'));
      execSync('git init -b main', { cwd: stagingDir, stdio: 'pipe' });
      execSync('git config user.email test@baton.local', { cwd: stagingDir, stdio: 'pipe' });
      execSync('git config user.name "Baton Test"', { cwd: stagingDir, stdio: 'pipe' });
      await writeFile(path.join(stagingDir, 'README.md'), '# test\n');
      execSync('git add -A && git commit -m init', { cwd: stagingDir, stdio: 'pipe' });
      execSync(`${cliRunner()} init`, { cwd: stagingDir, stdio: 'pipe' });
      execSync('git add -A && git commit -m "baton init"', { cwd: stagingDir, stdio: 'pipe' });
      await writeFile(path.join(stagingDir, '.baton-fixture-ok'), 'ok');
      try {
        rmSync(TEMPLATE_DIR, { recursive: true, force: true });
        renameSync(stagingDir, TEMPLATE_DIR);
      } catch {
        // Another worker won the race — its template is identical
        rmSync(stagingDir, { recursive: true, force: true });
      }
      return TEMPLATE_DIR;
    })();
  }
  return templateReady;
}

export async function createRepo(prefix = 'baton-test-'): Promise<string> {
  const template = await getTemplate();
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  execSync(`git clone --quiet "${template}" "${dir}"`, { stdio: 'pipe' });
  // clone does not carry the template's local user config
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

export function cliRunner(): string {
  const distCli = path.join(CLI_DIR, 'dist', 'cli.js');
  if (existsSync(distCli)) return `node "${distCli}"`;
  return `npx tsx "${path.join(CLI_DIR, 'src/cli.ts')}"`;
}

export function cliRunnerArgv(): string[] {
  const distCli = path.join(CLI_DIR, 'dist', 'cli.js');
  if (existsSync(distCli)) return ['node', distCli];
  return ['npx', 'tsx', path.join(CLI_DIR, 'src/cli.ts')];
}

export function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  // Quote any arg containing spaces so commander parses it as a single value.
  // Auto-append --allow-branch to ledger-writing commands when not on main.
  // Tests that explicitly need branch-guard failures pass --no-allow-branch via args.
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
    const stdout = execSync(`${cliRunner()} ${quotedArgs.join(' ')}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

export function gitSync(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export async function makeTempRepo(prefix = 'baton-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Write a task file directly with custom checks and commit it.
 * checks entries use the compact object form rendered into YAML front matter.
 */
export async function setupTask(
  repoDir: string,
  taskId: string,
  touches: string[],
  checks: Record<string, unknown>[],
): Promise<void> {
  const yamlText = [
    '---',
    'baton_version: 1',
    `id: ${taskId}`,
    `title: "Task ${taskId}"`,
    `touches: [${touches.map(t => `"${t}"`).join(', ')}]`,
    'reads: []',
    'decisions: []',
    'non_goals: []',
    'checks:',
    ...checks.map(c => {
      const parts = [`id: ${c.id}`, `type: ${c.type}`];
      if (Array.isArray(c.allow)) parts.push(`allow: [${(c.allow as string[]).map(a => `"${a}"`).join(', ')}]`);
      if (typeof c.run === 'string') parts.push(`run: "${c.run.replace(/\\/g, '\\\\').replace(/"/g, '\\\"')}"`);
      else if (Array.isArray(c.run)) parts.push(`run: [${(c.run as string[]).map(r => JSON.stringify(r)).join(', ')}]`);
      if (typeof c.file === 'string') parts.push(`file: "${c.file}"`);
      if (typeof c.path === 'string') parts.push(`path: "${c.path}"`);
      if (typeof c.pattern === 'string') parts.push(`pattern: "${c.pattern}"`);
      if (typeof c.mode === 'string') parts.push(`mode: ${c.mode}`);
      if (typeof c.expect === 'string') parts.push(`expect: ${c.expect}`);
      if (typeof c.exists === 'boolean') parts.push(`exists: ${c.exists}`);
      if (typeof c.description === 'string') parts.push(`description: "${c.description}"`);
      return `  - { ${parts.join(', ')} }`;
    }),
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

/**
 * Write a valid closeout report for the task on the current branch and commit.
 * changedFiles must match the actual diff (report_matches compares them).
 */
export async function writeReport(
  repoDir: string,
  taskId: string,
  changedFiles: string[],
  opts: { head?: string; base?: string; worker?: string; branch?: string } = {},
): Promise<void> {
  const num = taskId.split('-')[1];
  const head = opts.head ?? execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
  const base = opts.base ?? execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8' }).trim();
  const branch = opts.branch ?? 'baton/' + taskId + '-test';
  await mkdir(path.join(repoDir, 'project-memory/reports'), { recursive: true });
  const report = [
    '---',
    'baton_version: 1',
    `task: ${taskId}`,
    `worker: ${opts.worker ?? 'test-worker'}`,
    `branch: ${branch}`,
    `base_commit: ${base}`,
    `head_commit: ${head}`,
    'claims:',
    '  - { statement: "work done", key: "", evidence: "tests pass" }',
    `changed_files: [${changedFiles.map(f => `"${f}"`).join(', ')}]`,
    'not_done: []',
    'questions: []',
    'decisions_proposed: []',
    '---',
    '',
    '## Notes',
    '',
  ].join('\n');
  await writeFile(path.join(repoDir, 'project-memory/reports', `R-${num}.md`), report);
  execSync('git add -A && git commit -m "report"', { cwd: repoDir, stdio: 'pipe' });
}
