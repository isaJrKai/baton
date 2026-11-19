// v1.3.0 integration tests: search (BM25), lease, done, gate, MCP server.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  // All v1.3.0 tests run on the base branch (main), so no --allow-branch is
  // appended automatically; tests that need special flags pass them explicitly.
  const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
  try {
    const stdout = execSync(`npx tsx ${path.join(CLI_DIR, 'src/cli.ts')} ${quotedArgs.join(' ')}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-v13-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test repo\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

// ---------- search ----------

describe('v1.3.0: baton search (BM25)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
    await mkdir(path.join(repoDir, 'src/api'), { recursive: true });
    await mkdir(path.join(repoDir, 'src/config'), { recursive: true });
    await mkdir(path.join(repoDir, 'docs'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/api/handlers.ts'),
      'export function handleUserLogin() {\n  // the user login handler validates credentials\n  return "user login handler";\n}\n');
    await writeFile(path.join(repoDir, 'docs/notes.md'),
      '# Notes\nThe login flow reuses the session middleware.\nNothing about quantum calendars here.\n');
    await writeFile(path.join(repoDir, 'src/config/settings.ts'),
      'export const settings = {\n  password = "hunter2hunter2secret",\n  retryLimit: 3,\n};\n');
    // never_include target: must never be indexed
    await writeFile(path.join(repoDir, '.env.local'), 'SUPERSECRETVALUE=zzzquantumcalendarzzz\n');
    execSync('git add -A && git commit -m "files"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('ranks the matching file first and returns a snippet', () => {
    const r = runBaton(['search', 'user login handler', '--json'], repoDir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { path: string; score: number; snippet: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]?.path).toBe('src/api/handlers.ts');
    expect(parsed[0]?.snippet).toContain('login');
  });

  it('never indexes never_include files', () => {
    const r = runBaton(['search', 'zzzquantumcalendarzzz', '--json'], repoDir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { path: string }[];
    expect(parsed.length).toBe(0);
  });

  it('excludes files containing secret patterns entirely', () => {
    const r = runBaton(['search', 'retryLimit settings', '--json'], repoDir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { path: string; snippet: string }[];
    // settings.ts carries a secret-looking assignment — the whole file is
    // excluded from the corpus (stronger than snippet masking).
    for (const hit of parsed) {
      expect(hit.path).not.toBe('src/config/settings.ts');
      expect(hit.snippet).not.toContain('hunter2hunter2secret');
    }
  });

  it('formats human output with untrusted-content warning', () => {
    const r = runBaton(['search', 'login'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('untrusted');
  });
});

// ---------- lease ----------

describe('v1.3.0: baton lease (area leases)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
    runBaton(['task', 'new', 'First task', '--touches', 'src/**'], repoDir);
    runBaton(['task', 'new', 'Second task', '--touches', 'src/**'], repoDir);
    runBaton(['task', 'new', 'Unrelated task', '--touches', 'docs/**'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('take -> list -> release roundtrip', () => {
    const take = runBaton(['lease', 'take', 'T-0001', '--worker', 'worker-a'], repoDir);
    expect(take.code).toBe(0);
    expect(take.stdout).toContain('Lease taken');

    const list = runBaton(['lease', 'list'], repoDir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('T-0001');
    expect(list.stdout).toContain('worker-a');
    expect(list.stdout).toContain('src/**');

    const rel = runBaton(['lease', 'release', 'T-0001', '--reason', 'work complete'], repoDir);
    expect(rel.code).toBe(0);

    const list2 = runBaton(['lease', 'list'], repoDir);
    expect(list2.stdout).toContain('No active leases');
  });

  it('refuses overlapping lease on a different task (exit 5)', () => {
    const take1 = runBaton(['lease', 'take', 'T-0001', '--worker', 'worker-a'], repoDir);
    expect(take1.code).toBe(0);

    const take2 = runBaton(['lease', 'take', 'T-0002', '--worker', 'worker-b'], repoDir);
    expect(take2.code).toBe(5);
    expect(take2.stderr).toContain('overlapping active lease');

    // Re-take on the SAME task is also refused until release
    const retake = runBaton(['lease', 'take', 'T-0001', '--worker', 'worker-a'], repoDir);
    expect(retake.code).toBe(5);
    expect(retake.stderr).toContain('already holds an active lease');
  });

  it('allows non-overlapping leases concurrently', () => {
    const t1 = runBaton(['lease', 'take', 'T-0001', '--worker', 'worker-a'], repoDir);
    expect(t1.code).toBe(0);
    const t3 = runBaton(['lease', 'take', 'T-0003', '--worker', 'worker-c'], repoDir);
    expect(t3.code).toBe(0);

    const list = runBaton(['lease', 'list'], repoDir);
    expect(list.stdout).toContain('T-0001');
    expect(list.stdout).toContain('T-0003');
  });

  it('refuses lease for a missing task (exit 3)', () => {
    const r = runBaton(['lease', 'take', 'T-0099', '--worker', 'worker-a'], repoDir);
    expect(r.code).toBe(3);
  });
});

// ---------- done ----------

describe('v1.3.0: baton done (computable completion)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('reports NOT DONE on a fresh repo (zero tasks, exit 1)', () => {
    const r = runBaton(['done', '--json'], repoDir);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { done: boolean; gates: { id: string; pass: boolean }[] };
    expect(parsed.done).toBe(false);
    const g1 = parsed.gates.find(g => g.id === 'G1');
    expect(g1?.pass).toBe(false);
    // G2/G3/G4 pass on a fresh repo
    const g2 = parsed.gates.find(g => g.id === 'G2');
    const g3 = parsed.gates.find(g => g.id === 'G3');
    const g4 = parsed.gates.find(g => g.id === 'G4');
    expect(g2?.pass).toBe(true);
    expect(g3?.pass).toBe(true);
    expect(g4?.pass).toBe(true);
  });

  it('flags a draft task as not done', () => {
    runBaton(['task', 'new', 'Half-finished work', '--touches', 'src/**'], repoDir);
    const r = runBaton(['done', '--json'], repoDir);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { gates: { id: string; pass: boolean; detail: string }[] };
    const g1 = parsed.gates.find(g => g.id === 'G1');
    expect(g1?.pass).toBe(false);
    expect(g1?.detail).toContain('draft');
  });

  it('human output lists all seven gates', () => {
    const r = runBaton(['done'], repoDir);
    for (let i = 1; i <= 7; i++) {
      expect(r.stdout).toContain(`G${i}`);
    }
    expect(r.stdout).toContain('NOT DONE');
  });
});

// ---------- gate ----------

describe('v1.3.0: baton gate (CI gate)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('passes on a clean fresh repo', () => {
    const r = runBaton(['gate'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('BATON GATE: PASS');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('stale');
    expect(r.stdout).toContain('conflicts');
    expect(r.stdout).toContain('tasks');
  });

  it('--init writes the GitHub workflow and never overwrites', async () => {
    const r = runBaton(['gate', '--init'], repoDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Wrote .github/workflows/baton-gate.yml');

    const workflow = await import('node:fs/promises').then(fs =>
      fs.readFile(path.join(repoDir, '.github/workflows/baton-gate.yml'), 'utf8'));
    expect(workflow).toContain('Baton Gate');
    expect(workflow).toContain('baton gate');

    // Second run must not overwrite (simulate user edit)
    await import('node:fs/promises').then(fs =>
      fs.writeFile(path.join(repoDir, '.github/workflows/baton-gate.yml'), '# user edit\n'));
    const r2 = runBaton(['gate', '--init'], repoDir);
    expect(r2.stdout).toContain('already exists');
    const after = await import('node:fs/promises').then(fs =>
      fs.readFile(path.join(repoDir, '.github/workflows/baton-gate.yml'), 'utf8'));
    expect(after).toBe('# user edit\n');
  });

  it('json output is machine-parseable', () => {
    const r = runBaton(['gate', '--json'], repoDir);
    const parsed = JSON.parse(r.stdout) as { pass: boolean; checks: { name: string }[] };
    expect(parsed.pass).toBe(true);
    expect(parsed.checks.length).toBe(4);
  });
});

// ---------- MCP server ----------

describe('v1.3.0: baton mcp (lease/gate tools over stdio)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
    runBaton(['task', 'new', 'Mcp visible task', '--touches', 'src/**'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  function callMcp(input: string, cwd: string): { stdout: string; code: number } {
    const res = spawnSync('npx', ['tsx', path.join(CLI_DIR, 'src/cli.ts'), 'mcp'], {
      cwd, input, encoding: 'utf8', timeout: 60000,
    });
    return { stdout: res.stdout ?? '', code: res.status ?? 1 };
  }

  it('tools/list exposes the lease and gate tools', () => {
    const res = callMcp(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
      repoDir,
    );
    const resp = JSON.parse(res.stdout.trim()) as { result: { tools: { name: string }[] } };
    const names = resp.result.tools.map(t => t.name);
    expect(names).toContain('lease_take');
    expect(names).toContain('lease_list');
    expect(names).toContain('lease_release');
    expect(names).toContain('gate');
    expect(names).toContain('next_task');
    expect(names).toContain('project_done');
    expect(names).toContain('search_files');
    // verify is never exposed (G21)
    expect(names).not.toContain('verify');
  });

  it('lease_take / lease_list / gate roundtrip over MCP', () => {
    const res = callMcp(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lease_take', arguments: { task_id: 'T-0001', worker: 'agent-1' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lease_list', arguments: {} } }),
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gate', arguments: {} } }),
      ].join('\n') + '\n',
      repoDir,
    );
    const lines = res.stdout.trim().split('\n').filter(l => l.length > 0);
    const byId = new Map(lines.map(l => {
      const r = JSON.parse(l) as { id: number; result?: { content?: { text: string }[] } };
      return [r.id, r];
    }));
    const leased = byId.get(1)?.result?.content?.[0]?.text ?? '';
    expect(leased).toContain('leased');
    const listed = byId.get(2)?.result?.content?.[0]?.text ?? '';
    expect(listed).toContain('T-0001');
    const gateOut = byId.get(3)?.result?.content?.[0]?.text ?? '';
    expect(gateOut).toContain('doctor');
  });
});

// ---------- packet retrieval tier ----------

describe('v1.3.0: packet retrieval tier (auto, policy-gated)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/session.ts'),
      'export const SESSION_TIMEOUT_MS = 30_000;\n// session middleware used by login\n');
    execSync('git add -A && git commit -m "session helper"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['task', 'new', 'Session middleware hardening', '--touches', 'src/**'], repoDir);
    execSync('git add -A && git commit -m "task file"', { cwd: repoDir, stdio: 'pipe' });
    // Weak-check override keeps this test focused on the retrieval tier
    runBaton(['task', 'ready', 'T-0001', '--allow-weak', 'test override'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('packet includes the retrieved tier with UNTRUSTED markers by default', () => {
    const r = runBaton(['packet', 'T-0001'], repoDir);
    expect(r.code).toBe(0);
    const text = execSync('cat project-memory/packets/T-0001.md', { cwd: repoDir, encoding: 'utf8' });
    expect(text).toContain('Retrieved context (BM25');
    expect(text).toContain('BEGIN UNTRUSTED: src/session.ts');
    expect(text).toContain('END UNTRUSTED');
    expect(text).toContain('Omitted:');
  });

  it('retrieval_snippets: 0 in policy disables the tier', async () => {
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    const policyPath = path.join(repoDir, '.baton/policy.yml');
    const policy = await rf(policyPath, 'utf8');
    await wf(policyPath, policy + 'retrieval_snippets: 0\n');
    const r = runBaton(['packet', 'T-0001'], repoDir);
    expect(r.code).toBe(0);
    const text = execSync('cat project-memory/packets/T-0001.md', { cwd: repoDir, encoding: 'utf8' });
    expect(text).not.toContain('BEGIN UNTRUSTED: src/session.ts');
  });
});
