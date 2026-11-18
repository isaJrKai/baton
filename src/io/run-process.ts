// Process runner for cmd checks. G22, G23.
// v1.2 §6.7: timeout says "timed out after Ns", not "exit null".
// v1.2 G22: killed as a process tree on timeout (kills grandchildren too).
import { spawn, type ChildProcess } from 'node:child_process';

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
 * Run a command with argv array. Never uses shell. G16, G22, G23.
 *
 * v1.2: On timeout, kills the entire process tree (child + grandchildren)
 * using process group kill (detached spawn + kill(-pgid)).
 *
 * Environment is sanitized: only PATH, HOME/USERPROFILE, TEMP, LANG, CI plus
 * policy.env_passthrough. Drops TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL (case-insensitive)
 * unless in passthrough. G23.
 */
export function run(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; envPassthrough?: string[]; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const start = Date.now();

  // Build sanitized environment
  const passthrough = new Set([
    'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CI',
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
      try {
        // Kill the entire process group (negative PID)
        // This kills the child AND all its descendants (grandchildren)
        if (p.pid) {
          try { process.kill(-p.pid, 'SIGKILL'); }
          catch {
            // Fallback: kill just the child
            try { p.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
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
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}
