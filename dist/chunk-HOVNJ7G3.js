// src/io/git.ts
import { spawn } from "node:child_process";
import path from "node:path";
var ALLOWED_TOP = /* @__PURE__ */ new Set([
  "rev-parse",
  "diff",
  "log",
  "show",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
  "for-each-ref",
  "status",
  "worktree"
]);
var ALLOWED_WORKTREE_SUB = /* @__PURE__ */ new Set(["add", "remove", "list"]);
async function getGitRoot(startDir) {
  try {
    const r = await git(["rev-parse", "--show-toplevel"], { cwd: startDir });
    if (r.exitCode === 0) {
      return r.stdout.trim();
    }
  } catch {
  }
  return startDir;
}
function relativeToGitRoot(gitRoot, absPath) {
  return path.relative(gitRoot, absPath);
}
var FORBIDDEN_TOP = /* @__PURE__ */ new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "clean",
  "stash",
  "config",
  "init",
  "clone",
  "fetch",
  "pull",
  "remote",
  "submodule",
  "hook",
  "reflog"
]);
function git(args, opts) {
  const [cmd, ...rest] = args;
  if (!cmd) {
    return Promise.reject(new Error("git: no command provided"));
  }
  if (FORBIDDEN_TOP.has(cmd)) {
    return Promise.reject(new Error(`git ${cmd} is forbidden by G7`));
  }
  if (!ALLOWED_TOP.has(cmd)) {
    return Promise.reject(new Error(`git ${cmd} is not in the allowlist (G6)`));
  }
  if (cmd === "worktree") {
    const sub = rest[0];
    if (!sub || !ALLOWED_WORKTREE_SUB.has(sub)) {
      return Promise.reject(new Error(`git worktree ${sub ?? "<none>"} is not allowed`));
    }
  }
  if (cmd === "status" && rest[0] !== "--porcelain") {
    return Promise.reject(new Error("git status only allowed with --porcelain"));
  }
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: opts.cwd, shell: false });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    p.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("error", (err) => reject(new Error(`git spawn error: ${err.message}`)));
    p.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
function isValidRefName(name) {
  return /^[A-Za-z0-9._\/-]+$/.test(name) && !name.includes("..");
}
async function getCommitSha(repoRoot, ref = "HEAD") {
  if (!isValidRefName(ref) && ref !== "HEAD") {
    throw new Error(`invalid ref name: ${ref}`);
  }
  const r = await git(["rev-parse", "--verify", ref], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`rev-parse --verify ${ref} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}
async function getShortSha(repoRoot, ref = "HEAD") {
  const full = await getCommitSha(repoRoot, ref);
  return full.slice(0, 7);
}
async function diffNameOnly(repoRoot, base, head) {
  const r = await git(["diff", "--name-only", "--no-renames", base, head], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git diff --name-only failed: ${r.stderr}`);
  }
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
async function diffNameStatus(repoRoot, base, head) {
  const r = await git(["diff", "--name-status", "--no-renames", base, head], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${r.stderr}`);
  }
  return r.stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [status, ...rest] = l.split("	");
    return { status: status ?? "?", path: rest.join("	") };
  });
}
async function isGitRepo(repoRoot) {
  try {
    const r = await git(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
async function lsFilesAtRef(repoRoot, ref, prefix) {
  const gitRoot = await getGitRoot(repoRoot);
  const args = ["ls-tree", "-r", "--name-only", ref];
  if (prefix) {
    const gitRelativePrefix = path.relative(gitRoot, path.resolve(repoRoot, prefix));
    args.push("--", gitRelativePrefix);
  }
  const r = await git(args, { cwd: gitRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${r.stderr}`);
  }
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
async function readFileAtRef(repoRoot, ref, filePath) {
  const gitRoot = await getGitRoot(repoRoot);
  const gitRelativePath = path.relative(gitRoot, path.resolve(repoRoot, filePath));
  const r = await git(["show", `${ref}:${gitRelativePath}`], { cwd: gitRoot });
  if (r.exitCode !== 0) {
    throw new Error(`git show ${ref}:${gitRelativePath} failed: ${r.stderr}`);
  }
  return r.stdout;
}
async function fileExistsAtRef(repoRoot, ref, filePath) {
  try {
    const gitRoot = await getGitRoot(repoRoot);
    const gitRelativePath = path.relative(gitRoot, path.resolve(repoRoot, filePath));
    const r = await git(["cat-file", "-e", `${ref}:${gitRelativePath}`], { cwd: gitRoot });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
async function recentCommits(repoRoot, count, pathPrefix) {
  const args = ["log", "-n", String(count), "--format=%h %s"];
  if (pathPrefix) args.push("--", pathPrefix);
  const r = await git(args, { cwd: repoRoot });
  if (r.exitCode !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
async function cleanupStaleWorktrees(repoRoot) {
  const r = await git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  if (r.exitCode !== 0) return [];
  const removed = [];
  const blocks = r.stdout.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    if (!worktreeLine) continue;
    const wtPath = worktreeLine.slice("worktree ".length);
    if (wtPath.includes(".baton/tmp/wt-")) {
      try {
        await git(["worktree", "remove", "--force", wtPath], { cwd: repoRoot });
        removed.push(wtPath);
      } catch {
      }
    }
  }
  return removed;
}

export {
  getGitRoot,
  relativeToGitRoot,
  git,
  isValidRefName,
  getCommitSha,
  getShortSha,
  diffNameOnly,
  diffNameStatus,
  isGitRepo,
  lsFilesAtRef,
  readFileAtRef,
  fileExistsAtRef,
  recentCommits,
  cleanupStaleWorktrees
};
