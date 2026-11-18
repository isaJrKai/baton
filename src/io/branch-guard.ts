// Branch guard for ledger-writing commands.
// Owner-approved spec change: commands that write to ledger.jsonl refuse to run
// unless the current branch is the base branch (default: main). Override with --allow-branch.
import { git } from './git.js';

export interface BranchGuardOptions {
  allowBranch?: boolean;
}

export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  // `git rev-parse --abbrev-ref HEAD` returns "main", "feature/x", or "HEAD" if detached
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  if (r.exitCode !== 0) return null;
  const branch = r.stdout.trim();
  if (branch === 'HEAD') return null;  // detached HEAD
  return branch;
}

/**
 * Verify the current branch is the base branch. Throws with exitCode=4 if not.
 * Override with opts.allowBranch = true.
 */
export async function assertOnBaseBranch(
  repoRoot: string,
  baseBranch: string,
  opts: BranchGuardOptions = {},
): Promise<{ currentBranch: string | null; allowed: boolean }> {
  if (opts.allowBranch) {
    const current = await getCurrentBranch(repoRoot);
    return { currentBranch: current, allowed: true };
  }
  const current = await getCurrentBranch(repoRoot);
  if (current !== baseBranch) {
    const err = new Error(
      `ledger-writing command refused: current branch is ${current ?? '(detached)'}, must be ${baseBranch}. ` +
      `Override with --allow-branch.`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  return { currentBranch: current, allowed: true };
}
