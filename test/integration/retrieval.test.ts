// v1.3 integration: semantic retrieval (BM25).
// - baton search <query> ranks files by BM25, excludes never_include + secret files
// - packet includes the retrieved-context tier
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-retrieval-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('v1.3 retrieval: BM25 search', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    await writeFile(path.join(repoDir, 'README.md'), '# test repo\n');
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'src/parser.ts'),
      [
        '// The widget parser handles nested tokens.',
        'export function parseWidget(input: string): string {',
        '  // tokenizer: split nested token stream',
        "  return input.replace('nested', 'flat');",
        '}',
      ].join('\n'),
    );
    await writeFile(
      path.join(repoDir, 'src/router.md'),
      '# Router docs\n\nThe router never touches widget parsing. It handles HTTP routing only.',
    );
    // A file inside never_include (`.env*`) — must never be indexed
    await writeFile(
      path.join(repoDir, '.env.local'),
      'zanzibar_secret_lexicon=abc123\n',
    );
    execSync('git add -A && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('ranks the matching file first', () => {
    const r = runBaton(['search', 'widget parser nested tokens'], repoDir);
    expect(r.code).toBe(0);
    const firstHit = r.stdout.split('\n').find(l => l.includes('  ') && l.trim().length > 0 && /\S+\s+\S+\.\S+/.test(l));
    expect(firstHit).toBeDefined();
    expect(r.stdout).toContain('src/parser.ts');
    // router.md mentions the terms only via negation, so parser.ts must outrank it
    const parserPos = r.stdout.indexOf('src/parser.ts');
    const routerPos = r.stdout.indexOf('src/router.md');
    if (routerPos >= 0) expect(parserPos).toBeLessThan(routerPos);
  });

  it('excludes never_include files from the index', () => {
    const r = runBaton(['search', 'zanzibar secret lexicon'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('.env.local');
  });

  it('respects --glob and --top', () => {
    const r = runBaton(['search', 'widget parser', '--glob', 'src/*.md', '--top', '3'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('src/parser.ts');
  });

  it('json output is machine readable', () => {
    const r = runBaton(['search', 'widget parser', '--json'], repoDir);
    expect(r.code).toBe(0);
    const hits = JSON.parse(r.stdout) as { path: string; score: number; snippet: string }[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.path).toBeTruthy();
      expect(typeof h.score).toBe('number');
    }
  });

  it('falls back to ledger filtering when no query is given (v1.2 behavior)', () => {
    runBaton(['init'], repoDir);
    const r = runBaton(['search'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No matching events');
  });
});

describe('v1.3 retrieval: packet retrieved-context tier', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    await writeFile(path.join(repoDir, 'README.md'), '# test repo\n');
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'src/ledger-engine.ts'),
      '// ledger engine appends events to the jsonl ledger with fsync durability',
      { encoding: 'utf8' },
    );
    execSync('git add -A && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['init'], repoDir);
    runBaton(['task', 'new', 'repair ledger append durability', '--touches', 'src/**'], repoDir);
    execSync('git add -A && git commit -m "task"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'ready', 'T-0001'], repoDir);
    execSync('git add -A && git commit -m "task ready"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('packet contains the retrieved context tier with BM25 hits', async () => {
    const r = runBaton(['packet', 'T-0001'], repoDir);
    expect(r.code).toBe(0);
    const packetText = await readFile(path.join(repoDir, 'project-memory/packets/T-0001.md'), 'utf8');
    expect(packetText).toContain('Retrieved context');
    expect(packetText).toContain('src/ledger-engine.ts');
    expect(packetText).toContain('score');
  });
});
