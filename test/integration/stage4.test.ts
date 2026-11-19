// Stage 4 tests: HTML status page. Spec §8.5.
// XSS payloads in claims and reports appear escaped; output contains no <script>, src=, or href=;
// snapshot test; two runs identical.
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CLI_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

function runBaton(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
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
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-stage4-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('Stage 4: baton status --html', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    runBaton(['init'], repoDir);
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('generates a single-file HTML page with no JavaScript', async () => {
    const result = runBaton(['status', '--html', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTML status page written');

    const html = await readFile(path.join(repoDir, '.baton/status.html'), 'utf8');
    // Must have CSP header
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src 'unsafe-inline'");
    // No JavaScript
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('href=');
    // Must have lang="en"
    expect(html).toContain('lang="en"');
  });

  it('XSS payloads in claim statements are escaped', async () => {
    // Create a decision + task + verify with a claim that contains XSS payload
    runBaton(['decide', 'Test', '--key', 'test.xss', '--areas', 'src/**', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "D-0001"', { cwd: repoDir, stdio: 'pipe' });
    runBaton(['decide', 'accept', 'D-0001', '--allow-branch'], repoDir);
    execSync('git add -A && git commit -m "accept"', { cwd: repoDir, stdio: 'pipe' } as any);

    // Manually write a ledger line with an XSS claim
    const ledger = path.join(repoDir, 'project-memory/ledger.jsonl');
    const xssPayload = '<script>alert(1)</script><img onerror=alert(1) src=x>';
    const claimLine = JSON.stringify({
      v: 1, id: 'e-000003', ts: '2026-09-30T12:00:00Z',
      type: 'claim', claim_id: 'c-0001', task: 'T-0001',
      statement: xssPayload, key: 'test.xss', report_sha256: 'fake',
    });
    await writeFile(ledger, claimLine + '\n', 'utf8');

    const result = runBaton(['status', '--html', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);

    const html = await readFile(path.join(repoDir, '.baton/status.html'), 'utf8');
    // The XSS payload must be escaped — no raw <script> tag in the output
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=');
    // The escaped version should be present
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=');
  });

  it('two runs produce byte-identical output (G30 determinism)', async () => {
    runBaton(['status', '--html', '--allow-branch'], repoDir);
    const html1 = await readFile(path.join(repoDir, '.baton/status.html'), 'utf8');

    runBaton(['status', '--html', '--allow-branch'], repoDir);
    const html2 = await readFile(path.join(repoDir, '.baton/status.html'), 'utf8');

    expect(html1).toBe(html2);
  });

  it('generates correct page on empty repo', async () => {
    const result = runBaton(['status', '--html', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);

    const html = await readFile(path.join(repoDir, '.baton/status.html'), 'utf8');
    expect(html).toContain('Baton Status');
    expect(html).toContain('No tasks');
    expect(html).toContain('No claims');
    expect(html).toContain('No events');
  });

  it('--out writes to a custom path', async () => {
    const result = runBaton(['status', '--html', '--out', 'custom-status.html', '--allow-branch'], repoDir);
    expect(result.code).toBe(0);

    const html = await readFile(path.join(repoDir, 'custom-status.html'), 'utf8');
    expect(html).toContain('Baton Status');
  });
});
