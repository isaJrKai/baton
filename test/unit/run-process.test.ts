// v1.3.2 P1: cmd checks execute worker-written code. Passing the real HOME
// through lets that code read ~/.ssh, ~/.npmrc, .aws/credentials etc. The
// runner must give every run a throwaway HOME/TMPDIR and never let the real
// user profile leak in — not even via env_passthrough.
import { describe, it, expect } from 'vitest';
import { run, killProcessTree } from '../../src/io/run-process.js';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PRINT_ENV = 'const e = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE }; process.stdout.write(JSON.stringify(e))';

describe('run() environment sandbox (v1.3.2 P1)', () => {
  it('HOME points at a per-run temp dir, not the real HOME', async () => {
    const r = await run(['node', '-e', 'process.stdout.write(process.env.HOME)'], {
      cwd: os.tmpdir(), timeoutMs: 15000,
    });
    expect(r.code).toBe(0);
    const home = r.stdout.trim();
    expect(home).not.toBe(process.env.HOME);
    expect(home.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(home)).toMatch(/^baton-run-/);
  });

  it('TMPDIR / TEMP / USERPROFILE all point at the same per-run dir', async () => {
    const r = await run(['node', '-e', PRINT_ENV], { cwd: os.tmpdir(), timeoutMs: 15000 });
    expect(r.code).toBe(0);
    const e = JSON.parse(r.stdout) as Record<string, string | undefined>;
    expect(e.HOME).not.toBe(process.env.HOME);
    expect(e.HOME).toBe(e.TMPDIR);
    expect(e.HOME).toBe(e.TEMP);
    expect(e.USERPROFILE).toBe(e.HOME);
  });

  it('env_passthrough cannot restore the real HOME', async () => {
    const r = await run(['node', '-e', 'process.stdout.write(process.env.HOME)'], {
      cwd: os.tmpdir(), timeoutMs: 15000, envPassthrough: ['HOME'],
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).not.toBe(process.env.HOME);
  });

  it('opts.env cannot smuggle the real HOME in either', async () => {
    const r = await run(['node', '-e', 'process.stdout.write(process.env.HOME)'], {
      cwd: os.tmpdir(), timeoutMs: 15000, env: { HOME: process.env.HOME },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).not.toBe(process.env.HOME);
  });

  it('the per-run home dir is cleaned up after the run', async () => {
    const r = await run(['node', '-e', 'process.stdout.write(process.env.HOME)'], {
      cwd: os.tmpdir(), timeoutMs: 15000,
    });
    const dir = r.stdout.trim();
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    // Allow the cleanup tick to land
    await new Promise(res => setTimeout(res, 100));
    expect(existsSync(dir)).toBe(false);
  });

  it('secret-like env vars are still dropped (existing behavior)', async () => {
    process.env.BATON_TEST_TOKEN = 'supersecretvalue';
    try {
      const r = await run(['node', '-e', 'process.stdout.write(String(process.env.BATON_TEST_TOKEN))'], {
        cwd: os.tmpdir(), timeoutMs: 15000,
      });
      expect(r.stdout).not.toContain('supersecretvalue');
    } finally {
      delete process.env.BATON_TEST_TOKEN;
    }
  });
});

// v1.3.2 P3: process-tree kill is portable — process-group kill on POSIX,
// taskkill /T /F on Windows. The POSIX path is verified with a real child.
describe('killProcessTree (v1.3.2 P3)', () => {
  it('kills a spawned child process', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 200));
    expect(child.pid).toBeDefined();
    let aliveBefore = true;
    try { process.kill(child.pid!, 0); } catch { aliveBefore = false; }
    killProcessTree(child.pid!);
    await new Promise(res => setTimeout(res, 300));
    let aliveAfter = true;
    try { process.kill(child.pid!, 0); } catch { aliveAfter = false; }
    expect(aliveBefore).toBe(true);
    expect(aliveAfter).toBe(false);
  });
});
