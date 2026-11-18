// Check engine. Spec §6.5 / TABLE 4. Runs each check type in a worktree.
// P0-7: report_matches missing = fail (not skip)
// P0-9: worktree path includes task ID and PID
// P0-13: strength classification surfaces in verdict output
// v1.2 §6.7: run logs persisted to .baton/runs/<run>/<check>.log, {path,sha256} in check_result
// v1.2 §6.7: last 20 lines of failing check printed, sanitized (G18)
// v1.2 G22: killed as a process tree on timeout
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Check, Policy } from './schemas.js';
import { scan } from './secrets.js';
import { isMatch } from './globs.js';
import { run } from '../io/run-process.js';
import { diffNameStatus, diffNameOnly } from '../io/git.js';
import { sha256Sync } from '../io/hash.js';

export type CheckResult = {
  id: string;
  type: string;
  description?: string;
  result: 'pass' | 'fail' | 'skip';
  reason?: string;
  anchor?: { commit: string; watch: string[] };
  log?: { path: string; sha256: string };  // v1.2 §6.7: run log metadata
};

export interface CheckContext {
  repoRoot: string;
  worktreePath: string;      // .baton/tmp/wt-<taskId>-<runId>-<pid>
  baseCommit: string;        // v1.2 §6.4: merge-base(base, head) — used for diffs
  baseTip?: string;          // base branch tip — used for verify_run event only
  headCommit: string;
  taskTouches: string[];
  policy: Policy;
  report?: {
    changed_files: string[];
    head_commit: string;
  } | null;
  runId: string;
  taskId: string;
}

// diff_scope always-deny list per spec TABLE 4 row 2
// Plus build artifacts (node_modules, dist, .vite) that should never count as scope changes.
const ALWAYS_DENIED = [
  '.baton/**',
  'project-memory/tasks/**',
  'project-memory/decisions/**',
  'project-memory/ledger.jsonl',
  '.github/workflows/**',
  // Build artifacts — not source code, should never trip scope
  'node_modules/**',
  'dist/**',
  '.vite/**',
  '**/.vite/**',
];

// Check if a path is allowed by any of the allow globs
function pathAllowed(p: string, allow: string[]): boolean {
  return allow.some(g => isMatch(p, g));
}

// Check if a path matches any always-denied glob (unless explicitly allowed)
function pathExplicitlyAllowed(p: string, allow: string[]): boolean {
  return ALWAYS_DENIED.some(g => isMatch(p, g)) && allow.some(g => isMatch(p, g));
}

async function runDiffScope(ctx: CheckContext, check: Extract<Check, { type: 'diff_scope' }>): Promise<CheckResult> {
  try {
    const changes = await diffNameStatus(ctx.repoRoot, ctx.baseCommit, ctx.headCommit);
    const violations: string[] = [];
    for (const change of changes) {
      // Report file is always allowed
      if (change.path.match(/^project-memory\/reports\/R-\d+\.md$/)) continue;
      // Always-denied paths need explicit allow
      const isDenied = ALWAYS_DENIED.some(g => isMatch(change.path, g));
      if (isDenied) {
        // Only allowed if explicitly in allow list
        if (!pathAllowed(change.path, check.allow)) {
          violations.push(`${change.path} (${change.status}) [denied path not in allow]`);
        }
      } else {
        // Normal path: must be in allow
        if (!pathAllowed(change.path, check.allow)) {
          violations.push(`${change.path} (${change.status}) [outside scope]`);
        }
      }
    }
    if (violations.length > 0) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail',
        reason: `${violations.length} file(s) outside allow: ${violations.slice(0, 5).join(', ')}${violations.length > 5 ? '...' : ''}`,
      };
    }
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'pass',
      anchor: { commit: ctx.headCommit, watch: ctx.taskTouches },
    };
  } catch (err) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail', reason: `diff_scope error: ${(err as Error).message}`,
    };
  }
}

// G18: strip control characters and ANSI escapes (keep newline and tab)
function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // control chars except \t \n \r
    .replace(/\r/g, '');  // strip CR
}

// v1.2 §6.7: return last N lines of text, sanitized
function lastNLines(text: string, n: number): string {
  const lines = sanitize(text).split('\n').filter(l => l.length > 0);
  return lines.slice(-n).join('\n');
}

async function runCmd(ctx: CheckContext, check: Extract<Check, { type: 'cmd' }>): Promise<CheckResult> {
  // Verify command is allowlisted
  const allowEntry = ctx.policy.allowed_commands.find(a => {
    if (a.endsWith(' *')) {
      return check.run.startsWith(a.slice(0, -2));
    }
    return a === check.run;
  });
  if (!allowEntry) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail',
      reason: `command not on allowlist: ${check.run}. Add to .baton/policy.yml allowed_commands.`,
    };
  }
  // For " *" suffix, verify remaining args have no forbidden chars
  if (allowEntry.endsWith(' *')) {
    const suffix = check.run.slice(allowEntry.length - 2);
    if (/[;&|<>`$()\n]/.test(suffix)) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail', reason: `command arguments contain forbidden characters`,
      };
    }
  }
  // Split command into argv
  const argv = check.run.split(/\s+/).filter(Boolean);
  // Run in worktree
  const result = await run(argv, {
    cwd: ctx.worktreePath,
    timeoutMs: ctx.policy.execution.timeout_seconds * 1000,
    envPassthrough: ctx.policy.env_passthrough,
  });

  // v1.2 §6.7: persist output to .baton/runs/<run>/<check>.log
  const logDir = path.join(ctx.repoRoot, '.baton', 'runs', ctx.runId);
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${check.id}.log`);
  const logContent = `=== CMD: ${check.run} ===\n=== EXIT: ${result.code} ===\n=== TIMEOUT: ${result.timedOut} ===\n=== DURATION: ${result.durationMs}ms ===\n\n--- STDOUT ---\n${result.stdout}\n--- STDERR ---\n${result.stderr}\n`;
  await writeFile(logPath, logContent, 'utf8');
  const logSha = sha256Sync(logContent);
  const logMeta = { path: `.baton/runs/${ctx.runId}/${check.id}.log`, sha256: logSha };

  if (result.timedOut) {
    // v1.2 §6.7: timeout says "timed out after Ns", not "exit null"
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail',
      reason: `timed out after ${result.timeoutSeconds}s. Last 20 lines:\n${lastNLines(result.stderr || result.stdout, 20)}`,
      log: logMeta,
    };
  }
  if (result.code !== 0) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail',
      reason: `exit ${result.code}. Last 20 lines:\n${lastNLines(result.stderr || result.stdout, 20)}`,
      log: logMeta,
    };
  }
  return {
    id: check.id, type: check.type, description: check.description,
    result: 'pass',
    anchor: check.watch ? { commit: ctx.headCommit, watch: check.watch } : undefined,
    log: logMeta,
  };
}

async function runGrep(ctx: CheckContext, check: Extract<Check, { type: 'grep' }>): Promise<CheckResult> {
  try {
    const filePath = path.join(ctx.worktreePath, check.file);
    const content = await readFile(filePath, 'utf8').catch(() => null);
    if (content === null) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail', reason: `file not found: ${check.file}`,
      };
    }
    if (content.length > 1_000_000) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail', reason: `file exceeds 1MB: ${check.file}`,
      };
    }
    const regex = new RegExp(check.pattern);
    const matches = regex.test(content);
    const mode = check.mode ?? 'must_match';
    const pass = mode === 'must_match' ? matches : !matches;
    return {
      id: check.id, type: check.type, description: check.description,
      result: pass ? 'pass' : 'fail',
      reason: pass ? undefined : `${mode} failed for pattern /${check.pattern}/ in ${check.file}`,
      anchor: check.watch ? { commit: ctx.headCommit, watch: check.watch } : undefined,
    };
  } catch (err) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail', reason: `grep error: ${(err as Error).message}`,
    };
  }
}

async function runFileExists(ctx: CheckContext, check: Extract<Check, { type: 'file_exists' }>): Promise<CheckResult> {
  try {
    const filePath = path.join(ctx.worktreePath, check.path);
    const exists = check.exists ?? true;
    let fileExists = false;
    try {
      await readFile(filePath);
      fileExists = true;
    } catch { /* not found */ }
    const pass = exists === fileExists;
    return {
      id: check.id, type: check.type, description: check.description,
      result: pass ? 'pass' : 'fail',
      reason: pass ? undefined : `expected ${check.path} to ${exists ? 'exist' : 'not exist'}`,
      anchor: check.watch ? { commit: ctx.headCommit, watch: check.watch } : undefined,
    };
  } catch (err) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail', reason: `file_exists error: ${(err as Error).message}`,
    };
  }
}

async function runContract(ctx: CheckContext, check: Extract<Check, { type: 'contract' }>): Promise<CheckResult> {
  try {
    const filePath = path.join(ctx.worktreePath, check.file);
    const content = await readFile(filePath, 'utf8').catch(() => null);
    if (content === null) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail', reason: `contract file not found: ${check.file}`,
      };
    }
    // Parse as JSON or YAML by extension
    const ext = path.extname(check.file).toLowerCase();
    try {
      if (ext === '.json') JSON.parse(content);
      else if (ext === '.yaml' || ext === '.yml') {
        // Lazy load yaml — keeps pure-core testable
        const yaml = await import('yaml');
        yaml.parse(content);
      }
    } catch (err) {
      return {
        id: check.id, type: check.type, description: check.description,
        result: 'fail', reason: `parse failed: ${(err as Error).message}`,
      };
    }
    // expect: changed | unchanged | either
    if (check.expect && check.expect !== 'either') {
      const changedFiles = await diffNameOnly(ctx.repoRoot, ctx.baseCommit, ctx.headCommit);
      const isChanged = changedFiles.includes(check.file);
      if (check.expect === 'changed' && !isChanged) {
        return {
          id: check.id, type: check.type, description: check.description,
          result: 'fail', reason: `expected ${check.file} to be changed but it wasn't`,
        };
      }
      if (check.expect === 'unchanged' && isChanged) {
        return {
          id: check.id, type: check.type, description: check.description,
          result: 'fail', reason: `expected ${check.file} to be unchanged but it was modified`,
        };
      }
    }
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'pass',
      anchor: check.watch ? { commit: ctx.headCommit, watch: check.watch } : undefined,
    };
  } catch (err) {
    return {
      id: check.id, type: check.type, description: check.description,
      result: 'fail', reason: `contract error: ${(err as Error).message}`,
    };
  }
}

async function runNoSecrets(ctx: CheckContext): Promise<CheckResult> {
  try {
    // Get added lines only (git diff -U0 base..head)
    const { git } = await import('../io/git.js');
    const r = await git(['diff', '-U0', ctx.baseCommit, ctx.headCommit], { cwd: ctx.repoRoot });
    if (r.exitCode !== 0) {
      return {
        id: 'no_secrets', type: 'no_secrets',
        result: 'fail', reason: `git diff failed: ${r.stderr}`,
      };
    }
    // Extract added lines (starting with +, but not +++ )
    const addedLines = r.stdout.split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n');
    const findings = scan(addedLines, ctx.policy.extra_secret_patterns);
    if (findings.length > 0) {
      const masked = findings.slice(0, 5).map(f => `${f.name}@${f.line}:${f.masked}`).join(', ');
      return {
        id: 'no_secrets', type: 'no_secrets',
        result: 'fail',
        reason: `${findings.length} secret(s) found: ${masked}${findings.length > 5 ? '...' : ''}`,
      };
    }
    return { id: 'no_secrets', type: 'no_secrets', result: 'pass' };
  } catch (err) {
    return {
      id: 'no_secrets', type: 'no_secrets',
      result: 'fail', reason: `no_secrets error: ${(err as Error).message}`,
    };
  }
}

async function runReportMatches(ctx: CheckContext): Promise<CheckResult> {
  // P0-7: missing report = fail (not skip)
  if (!ctx.report) {
    return {
      id: 'report_matches', type: 'report_matches',
      result: 'fail',
      reason: 'no report at project-memory/reports/R-*.md on branch ' + ctx.headCommit.slice(0, 12) + ' — claims not recorded, questions not surfaced',
    };
  }
  // Verify head_commit matches verified head OR is an ancestor (report commit may be the latest,
  // with head_commit pointing to the worker-output commit before the report was added)
  const { git } = await import('../io/git.js');
  let headOk = ctx.report.head_commit === ctx.headCommit
    || ctx.headCommit.startsWith(ctx.report.head_commit);
  if (!headOk) {
    // Check ancestry: is report.head_commit an ancestor of ctx.headCommit?
    try {
      const r = await git(['merge-base', '--is-ancestor', ctx.report.head_commit, ctx.headCommit], { cwd: ctx.repoRoot });
      headOk = r.exitCode === 0;
    } catch {
      // fall through
    }
  }
  if (!headOk) {
    return {
      id: 'report_matches', type: 'report_matches',
      result: 'fail',
      reason: `head_commit in report (${ctx.report.head_commit.slice(0, 12)}) is not the verified head (${ctx.headCommit.slice(0, 12)}) or an ancestor`,
    };
  }
  // Empty claims = pass
  // Compare changed_files to diff path set
  try {
    const diffFiles = await diffNameOnly(ctx.repoRoot, ctx.baseCommit, ctx.headCommit);
    // Exclude report file from diff comparison
    const relevantDiff = diffFiles.filter(f => !f.match(/^project-memory\/reports\/R-\d+\.md$/));
    const reportSet = new Set(ctx.report.changed_files);
    const diffSet = new Set(relevantDiff);
    const missing = relevantDiff.filter(f => !reportSet.has(f));
    const extra = ctx.report.changed_files.filter(f => !diffSet.has(f));
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing ${missing.length} in report (${missing.slice(0, 3).join(', ')})`);
      if (extra.length > 0) parts.push(`extra ${extra.length} in report (${extra.slice(0, 3).join(', ')})`);
      return {
        id: 'report_matches', type: 'report_matches',
        result: 'fail', reason: parts.join('; '),
      };
    }
    return { id: 'report_matches', type: 'report_matches', result: 'pass' };
  } catch (err) {
    return {
      id: 'report_matches', type: 'report_matches',
      result: 'fail', reason: `report_matches error: ${(err as Error).message}`,
    };
  }
}

/**
 * Run all checks for a task. Returns results in declaration order,
 * with implicit report_matches appended at the end.
 */
export async function runAllChecks(ctx: CheckContext, checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const checkId = check.id;
    const checkType = check.type;
    const checkDescription: string | undefined = 'description' in check ? check.description : undefined;
    let result: CheckResult;
    switch (check.type) {
      case 'diff_scope':   result = await runDiffScope(ctx, check); break;
      case 'cmd':          result = await runCmd(ctx, check); break;
      case 'grep':         result = await runGrep(ctx, check); break;
      case 'file_exists':  result = await runFileExists(ctx, check); break;
      case 'contract':     result = await runContract(ctx, check); break;
      case 'no_secrets':   result = await runNoSecrets(ctx); break;
      default:
        // Exhaustiveness check — should never reach here
        result = {
          id: checkId, type: checkType, description: checkDescription,
          result: 'fail', reason: `unknown check type: ${checkType}`,
        };
    }
    results.push(result);
  }
  // Implicit report_matches
  results.push(await runReportMatches(ctx));
  return results;
}
