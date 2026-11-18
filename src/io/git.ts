// Git wrapper. G6, G7, G9, P0-10.
// Allowlist: rev-parse [--verify], diff, log, show, ls-files, ls-tree, cat-file,
//             merge-base, for-each-ref, status --porcelain,
//             worktree add --detach, worktree remove --force, worktree list.
// Explicitly forbidden (G7): commit, push, merge, rebase, reset, checkout, clean,
//                              stash, CONFIG, anything changing refs or hooks.
import { spawn } from 'node:child_process';
import path from 'node:path';

const ALLOWED_TOP = new Set([
  'rev-parse', 'diff', 'log', 'show', 'ls-files', 'ls-tree',
  'cat-file', 'merge-base', 'for-each-ref', 'status', 'worktree',
]);

const ALLOWED_WORKTREE_SUB = new Set(['add', 'remove', 'list']);

/**
 * Resolve the git root directory from a given starting directory.
 * Uses `git rev-parse --show-toplevel` which returns the absolute path
 * of the top-level directory of the working tree.
 * Returns the starting directory if not in a git repo.
 */
export async function getGitRoot(startDir: string): Promise<string> {
  try {
    const r = await git(['rev-parse', '--show-toplevel'], { cwd: startDir });
    if (r.exitCode === 0) {
      return r.stdout.trim();
    }
  } catch {
    // Not a git repo — return startDir
  }
  return startDir;
}

/**
 * Compute the relative path from the git root to a given absolute path.
 * Used when Baton is run from a subdirectory of the git repo.
 */
export function relativeToGitRoot(gitRoot: string, absPath: string): string {
  return path.relative(gitRoot, absPath);
}

// G7: explicitly forbidden commands. Even if a future contributor adds them to the
// allowlist, this check catches it.
const FORBIDDEN_TOP = new Set([
  'commit', 'push', 'merge', 'rebase', 'reset', 'checkout',
  'clean', 'stash', 'config', 'init', 'clone', 'fetch', 'pull',
  'remote', 'submodule', 'hook', 'reflog',
]);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git command. Args passed as argv array, never through a shell. G9.
 * Branch/commit names from user input must match ^[A-Za-z0-9._/-]+$ — caller responsibility.
 */
export function git(args: string[], opts: { cwd: string }): Promise<GitResult> {
  const [cmd, ...rest] = args;
  if (!cmd) {
    return Promise.reject(new Error('git: no command provided'));
  }
  if (FORBIDDEN_TOP.has(cmd)) {
    return Promise.reject(new Error(`git ${cmd} is forbidden by G7`));
  }
  if (!ALLOWED_TOP.has(cmd)) {
    return Promise.reject(new Error(`git ${cmd} is not in the allowlist (G6)`));
  }
  if (cmd === 'worktree') {
    const sub = rest[0];
    if (!sub || !ALLOWED_WORKTREE_SUB.has(sub)) {
      return Promise.reject(new Error(`git worktree ${sub ?? '<none>'} is not allowed`));
    }
  }
  if (cmd === 'status' && rest[0] !== '--porcelain') {
    return Promise.reject(new Error('git status only allowed with --porcelain'));
  }

  return new Promise<GitResult>((resolve, reject) => {
    const p = spawn('git', args, { cwd: opts.cwd, shell: false });
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', d => { stdout += d.toString(); });
    p.stderr?.on('data', d => { stderr += d.toString(); });
    p.on('error', err => reject(new Error(`git spawn error: ${err.message}`)));
    p.on('close', code => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Validate branch/commit name. G9: must match ^[A-Za-z0-9._/-]+$.
 */
export function isValidRefName(name: string): boolean {
  return /^[A-Za-z0-9._\/-]+$/.test(name) && !name.includes('..');
}

/**
 * Get the current commit SHA of a branch (or HEAD).
 */
export async function getCommitSha(repoRoot: string, ref: string = 'HEAD'): Promise<string> {
  if (!isValidRefName(ref) && ref !== 'HEAD') {
    throw new Error(`invalid ref name: ${ref}`);
  }
  const r = await git(['rev-parse', '--verify', ref], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`rev-parse --verify ${ref} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

/**
 * Get the current short commit SHA.
 */
export async function getShortSha(repoRoot: string, ref: string = 'HEAD'): Promise<string> {
  const full = await getCommitSha(repoRoot, ref);
  return full.slice(0, 7);
}

/**
 * List files changed between two commits (name-only, no renames).
 */
export async function diffNameOnly(repoRoot: string, base: string, head: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--no-renames', base, head], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git diff --name-only failed: ${r.stderr}`);
  }
  return r.stdout.split('\n').filter(l => l.length > 0);
}

/**
 * List changed files with status (added/modified/deleted).
 */
export async function diffNameStatus(repoRoot: string, base: string, head: string): Promise<{status: string; path: string}[]> {
  const r = await git(['diff', '--name-status', '--no-renames', base, head], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${r.stderr}`);
  }
  return r.stdout.split('\n').filter(l => l.length > 0).map(l => {
    const [status, ...rest] = l.split('\t');
    return { status: status ?? '?', path: rest.join('\t') };
  });
}

/**
 * Verify the repo is a git repo.
 */
export async function isGitRepo(repoRoot: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the list of files tracked by git at a ref.
 * Auto-resolves git root so it works when cwd is a subdirectory.
 */
export async function lsFilesAtRef(repoRoot: string, ref: string, prefix?: string): Promise<string[]> {
  const gitRoot = await getGitRoot(repoRoot);
  const args = ['ls-tree', '-r', '--name-only', ref];
  if (prefix) {
    const gitRelativePrefix = path.relative(gitRoot, path.resolve(repoRoot, prefix));
    args.push('--', gitRelativePrefix);
  }
  const r = await git(args, { cwd: gitRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${r.stderr}`);
  }
  return r.stdout.split('\n').filter(l => l.length > 0);
}

/**
 * Read a file's content from a specific git ref. Used by verify to read
 * the task file from the base branch (G17).
 * Auto-resolves git root so it works when cwd is a subdirectory of the git repo.
 */
export async function readFileAtRef(repoRoot: string, ref: string, filePath: string): Promise<string> {
  const gitRoot = await getGitRoot(repoRoot);
  const gitRelativePath = path.relative(gitRoot, path.resolve(repoRoot, filePath));
  const r = await git(['show', `${ref}:${gitRelativePath}`], { cwd: gitRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git show ${ref}:${gitRelativePath} failed: ${r.stderr}`);
  }
  return r.stdout;
}

/**
 * Check if a file exists at a given ref.
 * Auto-resolves git root so it works when cwd is a subdirectory of the git repo.
 */
export async function fileExistsAtRef(repoRoot: string, ref: string, filePath: string): Promise<boolean> {
  try {
    const gitRoot = await getGitRoot(repoRoot);
    const gitRelativePath = path.relative(gitRoot, path.resolve(repoRoot, filePath));
    const r = await git(['cat-file', '-e', `${ref}:${gitRelativePath}`], { cwd: gitRoot });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get last N commit subjects touching a path prefix.
 */
export async function recentCommits(
  repoRoot: string,
  count: number,
  pathPrefix?: string
): Promise<string[]> {
  const args = ['log', '-n', String(count), '--format=%h %s'];
  if (pathPrefix) args.push('--', pathPrefix);
  const r = await git(args, { cwd: repoRoot });
  if (r.exitCode !== 0) return [];
  return r.stdout.split('\n').filter(l => l.length > 0);
}

/**
 * v1.2 G8: On startup, remove stale worktrees Baton itself created.
 * Only removes worktrees whose path is under .baton/tmp/wt-*.
 * NEVER touches sibling worktrees (../wt-*) created by the worker checkout command (G45).
 */
export async function cleanupStaleWorktrees(repoRoot: string): Promise<string[]> {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (r.exitCode !== 0) return [];
  const removed: string[] = [];
  const blocks = r.stdout.split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.length > 0);
    const worktreeLine = lines.find(l => l.startsWith('worktree '));
    if (!worktreeLine) continue;
    const wtPath = worktreeLine.slice('worktree '.length);
    // Only clean up worktrees under .baton/tmp/wt-* (Baton's own verify worktrees)
    // NEVER touch ../wt-* (worker sibling worktrees per G45)
    if (wtPath.includes('.baton/tmp/wt-')) {
      try {
        await git(['worktree', 'remove', '--force', wtPath], { cwd: repoRoot });
        removed.push(wtPath);
      } catch {
        // May fail if already gone — ignore
      }
    }
  }
  return removed;
}
