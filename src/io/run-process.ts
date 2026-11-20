// Process runner for cmd checks. G22, G23.
// v1.2 §6.7: timeout says "timed out after Ns", not "exit null".
// v1.2 G22: killed as a process tree on timeout (kills grandchildren too).
// v1.3.2 P1: HOME / USERPROFILE / TMPDIR point at a throwaway per-run dir —
//   cmd checks execute worker-written code, and the real user profile must
//   never be reachable (~/.ssh, ~/.npmrc, .aws/credentials). Not even
//   env_passthrough or opts.env can restore the real values.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  timeoutSeconds: number;  // v1.2: for "timed out after Ns" message
  durationMs: number;
}

const MAX_OUTPUT = 10 * 1024 * 1024;  // 10 MB cap per stream

/**
 * v1.3.2: kill a spawned process tree portably.
 * POSIX: process-group kill (detached spawn + kill(-pgid)) — kills the child
 * AND all its descendants. Windows: process.kill(-pid) is unsupported, so use
 * `taskkill /pid <pid> /T /F` which walks the tree the same way.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore — process may already be gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch {
    // Fallback: kill just the child
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

/**
 * Run a command with argv array. Never uses shell. G16, G22, G23.
 *
 * v1.2: On timeout, kills the entire process tree (child + grandchildren).
 *
 * Environment is sanitized: only PATH, LANG, LC_ALL, CI plus policy
 * env_passthrough. HOME, USERPROFILE, TMPDIR, TEMP, TMP always point at a
 * per-run throwaway directory that is deleted when the run finishes.
 * TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL vars (case-insensitive) are dropped
 * unless in passthrough. G23.
 */
export function run(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; envPassthrough?: string[]; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const start = Date.now();

  // v1.3.2 P1: throwaway per-run home. Synchronous creation keeps run() async
  // signature simple; the dir is removed when the run settles.
  const sandboxHome = mkdtempSync(path.join(tmpdir(), 'baton-run-'));

  // Build sanitized environment
  const passthrough = new Set([
    'PATH', 'LANG', 'LC_ALL', 'CI',
    ...(opts.envPassthrough ?? []),
  ]);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) {
    if (v === undefined) continue;
    if (passthrough.has(k)) {
      childEnv[k] = v;
      continue;
    }
    // Drop secret-like env vars
    if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(k)) {
      continue;
    }
    // Drop non-passthrough vars (minimal environment)
  }
  // v1.3.2 P1: profile/tmp isolation always wins over passthrough or opts.env.
  childEnv['HOME'] = sandboxHome;
  childEnv['USERPROFILE'] = sandboxHome;
  childEnv['TMPDIR'] = sandboxHome;
  childEnv['TEMP'] = sandboxHome;
  childEnv['TMP'] = sandboxHome;

  const cleanup = () => {
    try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return new Promise<RunResult>((resolve) => {
    // detached: true creates a new process group so we can kill the whole tree
    const p = spawn(argv[0] ?? '', argv.slice(1), {
      cwd: opts.cwd,
      shell: false,
      env: childEnv,
      detached: true,  // v1.2 G22: new process group for tree kill
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cleanup();
      resolve({
        code, stdout, stderr, truncated, timedOut,
        timeoutSeconds,
        durationMs: Date.now() - start,
      });
    };

    p.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
      else truncated = true;
    });
    p.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
      else truncated = true;
    });

    p.on('error', () => {
      finish(1);
    });

    p.on('close', (code) => {
      finish(code);
    });

    // Custom timeout — kills the whole process tree
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (p.pid) killProcessTree(p.pid);
      // Give it a moment to die, then resolve
      setTimeout(() => finish(null), 100);
    }, timeoutMs);
  });
}

/**
 * Kill a child process and its entire process tree.
 * Used by callers that need to clean up on crash.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid) killProcessTree(child.pid);
}
