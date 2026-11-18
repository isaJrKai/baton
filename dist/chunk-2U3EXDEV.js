import {
  fileExistsAtRef,
  getCommitSha,
  getGitRoot,
  git
} from "./chunk-HOVNJ7G3.js";

// src/commands/done.ts
import { readFile as readFile5, readdir as readdir3 } from "node:fs/promises";
import path6 from "node:path";
import * as yaml4 from "yaml";

// src/io/ledger-file.ts
import { open as open2, readFile, mkdir } from "node:fs/promises";
import path2 from "node:path";

// src/io/lock.ts
import { open, unlink } from "node:fs/promises";
import path from "node:path";
var LOCK_FILE = "lock";
var heldLocks = /* @__PURE__ */ new Set();
async function lock(repoRoot) {
  const lockKey = path.resolve(repoRoot);
  if (heldLocks.has(lockKey)) return;
  const lockPath = path.join(repoRoot, ".baton", LOCK_FILE);
  for (let i = 0; i < 50; i++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      heldLocks.add(lockKey);
      return;
    } catch (err) {
      const code = err.code;
      if (code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, Math.min(40 * (i + 1), 2e3)));
    }
  }
  throw new Error(`could not acquire .baton/lock after 50 attempts (file: ${lockPath})`);
}
async function unlock(repoRoot) {
  const lockKey = path.resolve(repoRoot);
  if (!heldLocks.has(lockKey)) return;
  heldLocks.delete(lockKey);
  const lockPath = path.join(repoRoot, ".baton", LOCK_FILE);
  try {
    await unlink(lockPath);
  } catch {
  }
}
async function withLock(repoRoot, fn) {
  await lock(repoRoot);
  try {
    return await fn();
  } finally {
    await unlock(repoRoot);
  }
}

// src/io/ledger-file.ts
var LEDGER_PATH = "project-memory/ledger.jsonl";
var MAX_LINE_BYTES = 64 * 1024;
function ledgerFile(repoRoot) {
  return path2.join(repoRoot, LEDGER_PATH);
}
async function appendLedger(repoRoot, event) {
  const line = JSON.stringify(event) + "\n";
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    throw new Error(`ledger line exceeds 64KB: ${event.id}`);
  }
  await mkdir(path2.dirname(ledgerFile(repoRoot)), { recursive: true });
  await withLock(repoRoot, async () => {
    const fh = await open2(ledgerFile(repoRoot), "a");
    try {
      await fh.writeFile(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}
async function readLedger(repoRoot) {
  let text;
  try {
    text = await readFile(ledgerFile(repoRoot), "utf8");
  } catch {
    return { events: [], malformed: [] };
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const events = [];
  const malformed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed.push({ line: i + 1, text: line });
    }
  }
  return { events, malformed };
}
async function nextEventId(repoRoot) {
  const { events } = await readLedger(repoRoot);
  const existing = events.map((e) => e.id);
  const nums = existing.map((s) => parseInt(s.split("-")[1] ?? "0", 10)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `e-${String(next).padStart(6, "0")}`;
}
async function nextClaimId(repoRoot) {
  const { events } = await readLedger(repoRoot);
  const existing = events.filter((e) => e.type === "claim" && "claim_id" in e).map((e) => e.claim_id);
  const nums = existing.map((s) => parseInt(s.split("-")[1] ?? "0", 10)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `c-${String(next).padStart(4, "0")}`;
}
async function nextRunId(repoRoot) {
  const { events } = await readLedger(repoRoot);
  const existing = events.filter((e) => e.type === "verify_run" && "run_id" in e).map((e) => e.run_id);
  const nums = existing.map((s) => parseInt(s.split("-")[1] ?? "0", 10)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `r-${String(next).padStart(4, "0")}`;
}
function claimDedupeKey(claim) {
  return `${claim.task}|${claim.statement}|${claim.key ?? ""}`;
}
function claimStatusDedupeKey(event) {
  const commit = event.anchor?.commit ?? "";
  const runId = event.run_id ?? "";
  return `${event.claim_id}|${event.status}|${commit}|${runId}`;
}

// src/core/ledger-replay.ts
function replay(events) {
  const state = {
    tasks: /* @__PURE__ */ new Map(),
    claims: /* @__PURE__ */ new Map(),
    decisions: /* @__PURE__ */ new Map(),
    lastVerifyBase: /* @__PURE__ */ new Map(),
    leases: /* @__PURE__ */ new Map()
  };
  const seenClaimKeys = /* @__PURE__ */ new Set();
  const seenClaimStatusKeys = /* @__PURE__ */ new Set();
  for (const e of events) {
    if (e.type === "task_locked") {
      state.tasks.set(e.task, { status: "ready", lockedHash: e.hash, baseCommit: e.base_commit });
    } else if (e.type === "task_unlocked") {
      state.tasks.set(e.task, { status: "draft" });
    } else if (e.type === "packet_issued") {
      const t = state.tasks.get(e.task);
      if (t) {
        if (t.status === "ready" || t.status === "needs_work") t.status = "assigned";
      }
    } else if (e.type === "claim") {
      const dedupeKey = claimDedupeKey({ task: e.task, statement: e.statement, key: e.key });
      if (seenClaimKeys.has(dedupeKey)) continue;
      seenClaimKeys.add(dedupeKey);
      state.claims.set(e.claim_id, {
        taskId: e.task,
        statement: e.statement,
        key: e.key,
        status: "reported"
      });
    } else if (e.type === "claim_status") {
      const dedupeKey = claimStatusDedupeKey({
        claim_id: e.claim_id,
        status: e.status,
        anchor: e.anchor,
        run_id: e.run_id
      });
      if (seenClaimStatusKeys.has(dedupeKey)) continue;
      seenClaimStatusKeys.add(dedupeKey);
      const c = state.claims.get(e.claim_id);
      if (c) {
        c.status = e.status;
        if (e.anchor) c.anchor = e.anchor;
        if (e.run_id) c.runId = e.run_id;
      }
    } else if (e.type === "verify_run") {
      const t = state.tasks.get(e.task);
      if (t) {
        state.lastVerifyBase.set(e.task, e.base_commit);
        t.latestVerifyHead = e.head_commit;
        if (e.verdict === "all_pass" && (t.status === "assigned" || t.status === "in_review" || t.status === "needs_work" || t.status === "ready")) {
          t.status = "in_review";
        } else if (e.verdict === "has_failures" || e.verdict === "incomplete") {
          if (t.status !== "in_review") t.status = "needs_work";
        }
      }
    } else if (e.type === "accepted") {
      const t = state.tasks.get(e.task);
      if (t) t.status = "done";
    } else if (e.type === "rejected") {
      const t = state.tasks.get(e.task);
      if (t) {
        t.status = "rejected";
        if (e.follow_up_task) t.followUpTask = e.follow_up_task;
      }
    } else if (e.type === "blocked") {
      const t = state.tasks.get(e.task);
      if (t) {
        t.priorStatus = t.status;
        t.status = "blocked";
      }
    } else if (e.type === "unblocked") {
      const t = state.tasks.get(e.task);
      if (t && t.priorStatus) {
        t.status = t.priorStatus;
        t.priorStatus = void 0;
      }
    } else if (e.type === "decision_status") {
      const d = state.decisions.get(e.decision) ?? { status: "proposed" };
      d.status = e.to;
      if (e.hash) d.hash = e.hash;
      state.decisions.set(e.decision, d);
    } else if (e.type === "lease_acquired") {
      state.leases.set(e.task, {
        worker: e.worker,
        areas: e.areas,
        ttlMinutes: e.ttl_minutes,
        acquiredAt: e.ts
      });
    } else if (e.type === "lease_released") {
      const l = state.leases.get(e.task);
      if (l && !l.releasedAt) l.releasedAt = e.ts;
    }
  }
  return state;
}
function activeLeases(state, nowMs = Date.now()) {
  const out = [];
  for (const [task, l] of state.leases) {
    if (l.releasedAt) continue;
    const expiresMs = Date.parse(l.acquiredAt) + l.ttlMinutes * 6e4;
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) continue;
    out.push({ task, worker: l.worker, areas: l.areas, expiresAt: new Date(expiresMs).toISOString() });
  }
  return out.sort((a, b) => a.task.localeCompare(b.task));
}

// src/commands/doctor.ts
import { readFile as readFile2, readdir } from "node:fs/promises";
import path3 from "node:path";
import * as yaml from "yaml";
function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return { frontMatter: yaml.parse(m[1] ?? ""), body: m[2] ?? "" };
  } catch {
    return null;
  }
}
async function doctor(repoRoot) {
  const findings = [];
  const { events, malformed } = await readLedger(repoRoot);
  if (malformed.length > 0) {
    for (const m of malformed) {
      findings.push({
        level: "error",
        code: "E_LEDGER_MALFORMED",
        message: `ledger.jsonl:${m.line}: malformed JSON`,
        fix: "Edit or remove the malformed line. Run: baton doctor --fix (not implemented)"
      });
    }
  }
  let lastId = 0;
  for (const e of events) {
    const num = parseInt(e.id.split("-")[1] ?? "0", 10);
    if (num <= lastId && lastId > 0) {
      findings.push({
        level: "error",
        code: "E_NON_INCREASING_ID",
        message: `ledger.jsonl: non-increasing ID ${e.id} after e-${String(lastId).padStart(6, "0")}`,
        fix: "Restore the base branch ledger and re-run the affected command"
      });
    }
    lastId = Math.max(lastId, num);
  }
  const tasksDir = path3.join(repoRoot, "project-memory/tasks");
  let taskFiles;
  try {
    taskFiles = await readdir(tasksDir);
  } catch {
    taskFiles = [];
  }
  const taskIds = /* @__PURE__ */ new Set();
  for (const f of taskFiles) {
    if (!f.endsWith(".md")) continue;
    const taskId = f.replace(/\.md$/, "");
    if (taskIds.has(taskId)) {
      findings.push({ level: "error", code: "E_DUPLICATE_TASK_ID", message: `duplicate task ID: ${taskId}` });
    }
    taskIds.add(taskId);
    const text = await readFile2(path3.join(tasksDir, f), "utf8").catch(() => "");
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: "error", code: "E_UNPARSEABLE", message: `${f}: front matter parse failed` });
    }
  }
  const decisionsDir = path3.join(repoRoot, "project-memory/decisions");
  let decisionFiles;
  try {
    decisionFiles = await readdir(decisionsDir);
  } catch {
    decisionFiles = [];
  }
  const decisionIds = /* @__PURE__ */ new Set();
  for (const f of decisionFiles) {
    if (!f.endsWith(".md")) continue;
    const decisionId = f.replace(/\.md$/, "");
    if (decisionIds.has(decisionId)) {
      findings.push({ level: "error", code: "E_DUPLICATE_DECISION_ID", message: `duplicate decision ID: ${decisionId}` });
    }
    decisionIds.add(decisionId);
    const text = await readFile2(path3.join(decisionsDir, f), "utf8").catch(() => "");
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: "error", code: "E_UNPARSEABLE", message: `${f}: front matter parse failed` });
    }
  }
  const state = replay(events);
  let baseBranch = "main";
  try {
    const policyText = await readFile2(path3.join(repoRoot, ".baton/policy.yml"), "utf8");
    const policyRaw = yaml.parse(policyText);
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch {
  }
  for (const [taskId, t] of state.tasks) {
    if (!t.lockedHash) continue;
    const taskPath = `project-memory/tasks/${taskId}.md`;
    const exists = await fileExistsAtRef(repoRoot, baseBranch, taskPath);
    if (!exists) {
      findings.push({
        level: "error",
        code: "E_LOCK_HASH_MISMATCH",
        message: `task ${taskId}: locked but not found on ${baseBranch}`,
        fix: `baton task unlock ${taskId} --reason "not on base"`
      });
    }
  }
  try {
    const wtResult = await git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
    if (wtResult.exitCode === 0) {
      const blocks = wtResult.stdout.split("\n\n");
      for (const block of blocks) {
        const lines = block.split("\n").filter((l) => l.length > 0);
        const wtLine = lines.find((l) => l.startsWith("worktree "));
        if (!wtLine) continue;
        const wtPath = wtLine.slice("worktree ".length);
        if (wtPath.includes(".baton/tmp/wt-")) {
          findings.push({
            level: "error",
            code: "E_STALE_WORKTREE",
            message: `stale worktree: ${wtPath}`,
            fix: "git worktree remove --force " + wtPath
          });
        }
      }
    }
  } catch {
  }
  try {
    const stateText = await readFile2(path3.join(repoRoot, "project-memory/STATE.md"), "utf8");
    const lineCount = stateText.split("\n").length;
    if (lineCount > 60) {
      findings.push({
        level: "warning",
        code: "W_STATE_TOO_LONG",
        message: `STATE.md is ${lineCount} lines (guidance: 60)`
      });
    }
  } catch {
  }
  try {
    const gitignore = await readFile2(path3.join(repoRoot, ".gitignore"), "utf8");
    const required = ["project-memory/packets/", "project-memory/sessions/", ".baton/"];
    for (const r of required) {
      if (!gitignore.includes(r)) {
        findings.push({ level: "warning", code: "W_MISSING_GITIGNORE", message: `.gitignore missing: ${r}` });
      }
    }
  } catch {
  }
  const hasErrors = findings.some((f) => f.level === "error");
  return { findings, hasErrors };
}
function formatDoctorOutput(result) {
  const lines = [];
  const errors = result.findings.filter((f) => f.level === "error");
  const warnings = result.findings.filter((f) => f.level === "warning");
  if (errors.length > 0) {
    lines.push(`ERRORS (${errors.length})`);
    for (const e of errors) {
      lines.push(`  ${e.code}: ${e.message}`);
      if (e.fix) lines.push(`    fix: ${e.fix}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`WARNINGS (${warnings.length})`);
    for (const w of warnings) {
      lines.push(`  ${w.code}: ${w.message}`);
    }
  }
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("No issues found. All clear.");
  }
  return lines.join("\n");
}

// src/core/globs.ts
import picomatch from "picomatch";
function toPosix(p) {
  return p.replace(/\\/g, "/");
}
function isMatch(path7, glob) {
  const posixPath = toPosix(path7);
  const posixGlob = toPosix(glob);
  return picomatch(posixGlob, { dot: true })(posixPath);
}
function staticPrefix(glob) {
  const segments = toPosix(glob).split("/").filter((s) => s.length > 0);
  const result = [];
  for (const seg of segments) {
    if (/[*?[\]{}()!]/.test(seg)) break;
    result.push(seg);
  }
  return result.join("/");
}
function overlaps(a, b) {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === "" || pb === "") return true;
  if (pa === pb) return true;
  const paSegs = pa.split("/");
  const pbSegs = pb.split("/");
  const minLen = Math.min(paSegs.length, pbSegs.length);
  for (let i = 0; i < minLen; i++) {
    if (paSegs[i] !== pbSegs[i]) return false;
  }
  return true;
}

// src/commands/stale.ts
import * as yaml2 from "yaml";
import { readFile as readFile3 } from "node:fs/promises";
import path4 from "node:path";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function getBlobIds(repoRoot, ref) {
  const gitRoot = await getGitRoot(repoRoot);
  const r = await git(["ls-tree", "-r", ref], { cwd: gitRoot });
  const result = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("	");
    if (parts.length !== 2) continue;
    const meta = parts[0].split(" ");
    const blobId = meta[2];
    const filePath = parts[1];
    if (blobId && filePath) {
      result.set(filePath, blobId);
    }
  }
  return result;
}
async function stale(repoRoot, opts = {}) {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  let baseBranch = opts.baseBranch ?? "main";
  try {
    const policyText = await readFile3(path4.join(repoRoot, ".baton/policy.yml"), "utf8");
    const policyRaw = yaml2.parse(policyText);
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch {
  }
  const baseTip = await getCommitSha(repoRoot, baseBranch);
  const baseBlobs = await getBlobIds(repoRoot, baseBranch);
  const staleClaims = [];
  let totalChecked = 0;
  for (const [claimId, claim] of state.claims) {
    if (claim.status !== "verified") continue;
    if (!claim.anchor) continue;
    totalChecked++;
    const anchorCommit = claim.anchor.commit;
    const watchGlobs = claim.anchor.watch.length > 0 ? claim.anchor.watch : [];
    const anchorBlobs = await getBlobIds(repoRoot, anchorCommit);
    const taskState = state.tasks.get(claim.taskId);
    const isDone = taskState?.status === "done";
    if (isDone) {
      for (const [filePath, anchorBlob] of anchorBlobs) {
        const isWatched = watchGlobs.length === 0 || watchGlobs.some((g) => isMatch(filePath, g));
        if (!isWatched) continue;
        const baseBlob = baseBlobs.get(filePath);
        if (!baseBlob) {
          staleClaims.push({ taskId: claim.taskId, claimId, reason: "watch_missing" });
          break;
        }
        if (baseBlob !== anchorBlob) {
          const mbResult = await git(["merge-base", "--is-ancestor", anchorCommit, baseTip], { cwd: repoRoot });
          if (mbResult.exitCode !== 0) {
            staleClaims.push({ taskId: claim.taskId, claimId, reason: "differs_from_base" });
          } else {
            staleClaims.push({ taskId: claim.taskId, claimId, reason: "changed_since_verified" });
          }
          break;
        }
      }
    } else {
      if (anchorCommit !== baseTip) {
        staleClaims.push({ taskId: claim.taskId, claimId, reason: "branch_moved" });
      }
    }
  }
  if (!opts.dryRun && staleClaims.length > 0) {
    await withLock(repoRoot, async () => {
      const { events: currentEvents } = await readLedger(repoRoot);
      const seenKeys = new Set(
        currentEvents.filter((e) => e.type === "claim_status").map((e) => {
          const cs = e;
          return claimStatusDedupeKey({ claim_id: cs.claim_id, status: cs.status, anchor: cs.anchor, run_id: cs.run_id });
        })
      );
      for (const sc of staleClaims) {
        const dedupeKey = claimStatusDedupeKey({
          claim_id: sc.claimId,
          status: "stale",
          anchor: void 0,
          run_id: void 0
        });
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const eventId = await nextEventId(repoRoot);
        await appendLedger(repoRoot, {
          v: 1,
          id: eventId,
          ts: nowIso(),
          type: "claim_status",
          claim_id: sc.claimId,
          status: "stale",
          reason: sc.reason
        });
      }
    });
  }
  return { staleClaims, totalChecked };
}
function formatStaleTable(result) {
  const lines = [];
  lines.push(`Staleness check: ${result.totalChecked} verified claims checked, ${result.staleClaims.length} stale.`);
  if (result.staleClaims.length > 0) {
    lines.push("");
    lines.push("CLAIM       TASK     REASON");
    for (const sc of result.staleClaims) {
      lines.push(`${sc.claimId.padEnd(12)} ${sc.taskId.padEnd(8)} ${sc.reason}`);
    }
  } else {
    lines.push("No stale claims.");
  }
  return lines.join("\n");
}

// src/commands/conflicts.ts
import { readFile as readFile4, readdir as readdir2 } from "node:fs/promises";
import path5 from "node:path";
import * as yaml3 from "yaml";
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function parseFrontMatter2(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("front matter not found");
  return { frontMatter: yaml3.parse(m[1] ?? ""), body: m[2] ?? "" };
}
async function conflicts(repoRoot, opts = {}) {
  const { events } = await readLedger(repoRoot);
  if (opts.ack !== void 0 || opts.unack !== void 0) {
    const key = opts.ack ?? opts.unack;
    const note = opts.ackNote ?? opts.unackNote ?? "";
    if (key) {
      const isAck = opts.ack !== void 0;
      await withLock(repoRoot, async () => {
        const eventId = await nextEventId(repoRoot);
        await appendLedger(repoRoot, {
          v: 1,
          id: eventId,
          ts: nowIso2(),
          type: "conflict_ack",
          key,
          note
        });
      });
      console.log(`Conflict ${key} ${isAck ? "acknowledged" : "unacknowledged"}: ${note}`);
    }
  }
  const state = replay(events);
  const ackedKeys = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.type === "conflict_ack") {
      const ca = e;
      ackedKeys.set(ca.key, { acknowledged: true, note: ca.note });
    }
  }
  const decisionsByKey = /* @__PURE__ */ new Map();
  const decisionsDir = path5.join(repoRoot, "project-memory/decisions");
  let decisionFiles;
  try {
    decisionFiles = await readdir2(decisionsDir);
  } catch {
    decisionFiles = [];
  }
  for (const f of decisionFiles) {
    if (!f.endsWith(".md")) continue;
    try {
      const text = await readFile4(path5.join(decisionsDir, f), "utf8");
      const { frontMatter } = parseFrontMatter2(text);
      const id = frontMatter.id;
      const title = frontMatter.title;
      const key = frontMatter.key;
      const status = frontMatter.status;
      if (status !== "accepted") continue;
      const list = decisionsByKey.get(key) ?? [];
      list.push({ id, title });
      decisionsByKey.set(key, list);
    } catch {
    }
  }
  const decisionConflicts = [];
  for (const [key, list] of decisionsByKey) {
    if (list.length > 1) {
      decisionConflicts.push({
        key,
        decisions: list,
        acknowledged: ackedKeys.has(key)
      });
    }
  }
  const claimsByKey = /* @__PURE__ */ new Map();
  for (const [id, claim] of state.claims) {
    if (!claim.key) continue;
    if (claim.status === "stale") continue;
    const list = claimsByKey.get(claim.key) ?? [];
    list.push({ id, statement: claim.statement });
    claimsByKey.set(claim.key, list);
  }
  const claimConflicts = [];
  for (const [key, list] of claimsByKey) {
    if (list.length > 1 && new Set(list.map((c) => c.statement)).size > 1) {
      claimConflicts.push({
        key,
        claims: list,
        acknowledged: ackedKeys.has(key)
      });
    }
  }
  return { decisionConflicts, claimConflicts };
}
function formatConflictsTable(result) {
  const lines = [];
  if (result.decisionConflicts.length === 0 && result.claimConflicts.length === 0) {
    lines.push("No conflicts found.");
    return lines.join("\n");
  }
  if (result.decisionConflicts.length > 0) {
    lines.push("Decision conflicts:");
    for (const dc of result.decisionConflicts) {
      const ack = dc.acknowledged ? " [acknowledged]" : "";
      lines.push(`  key: ${dc.key}${ack}`);
      for (const d of dc.decisions) {
        lines.push(`    ${d.id}: ${d.title}`);
      }
    }
  }
  if (result.claimConflicts.length > 0) {
    lines.push("Claim conflicts (possible):");
    for (const cc of result.claimConflicts) {
      const ack = cc.acknowledged ? " [acknowledged]" : "";
      lines.push(`  key: ${cc.key}${ack}`);
      for (const c of cc.claims) {
        lines.push(`    ${c.id}: ${c.statement}`);
      }
    }
  }
  return lines.join("\n");
}

// src/commands/done.ts
function parseFrontMatter3(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("front matter not found");
  return yaml4.parse(m[1] ?? "");
}
async function done(repoRoot) {
  const gates = [];
  const { events } = await readLedger(repoRoot);
  const state = replay(events);
  let taskFiles = [];
  try {
    taskFiles = (await readdir3(path6.join(repoRoot, "project-memory/tasks"))).filter((f) => f.endsWith(".md"));
  } catch {
    taskFiles = [];
  }
  const offenders = [];
  for (const f of taskFiles) {
    const taskId = f.replace(/\.md$/, "");
    const t = state.tasks.get(taskId);
    if (!t) {
      offenders.push(`${taskId} (draft \u2014 never locked)`);
      continue;
    }
    if (t.status === "done") continue;
    if (t.status === "rejected" && t.followUpTask) {
      const fu = state.tasks.get(t.followUpTask);
      if (fu?.status === "done") continue;
      offenders.push(`${taskId} (rejected, follow-up ${t.followUpTask} not done)`);
      continue;
    }
    offenders.push(`${taskId} (${t.status})`);
  }
  for (const [taskId, t] of state.tasks) {
    if (!taskFiles.includes(`${taskId}.md`)) {
      offenders.push(`${taskId} (${t.status}, task file missing)`);
    }
  }
  gates.push({
    id: "G1",
    label: "All tasks done",
    pass: offenders.length === 0 && taskFiles.length > 0,
    detail: offenders.length === 0 ? `${taskFiles.length} task(s), all done` : offenders.join("; ")
  });
  const staleResult = await stale(repoRoot, { dryRun: true });
  gates.push({
    id: "G2",
    label: "Zero stale verified claims",
    pass: staleResult.staleClaims.length === 0,
    detail: `${staleResult.totalChecked} checked, ${staleResult.staleClaims.length} stale`
  });
  const conflictResult = await conflicts(repoRoot, {});
  const unresolved = [
    ...conflictResult.decisionConflicts.filter((c) => !c.acknowledged),
    ...conflictResult.claimConflicts.filter((c) => !c.acknowledged)
  ];
  gates.push({
    id: "G3",
    label: "Zero unacknowledged conflicts",
    pass: unresolved.length === 0,
    detail: unresolved.length === 0 ? "no conflicts" : unresolved.map((c) => c.key).join(", ")
  });
  const doctorResult = await doctor(repoRoot);
  const doctorErrors = doctorResult.findings.filter((f) => f.level === "error");
  gates.push({
    id: "G4",
    label: "doctor reports no errors",
    pass: !doctorResult.hasErrors,
    detail: doctorErrors.length === 0 ? `${doctorResult.findings.filter((f) => f.level === "warning").length} warning(s)` : doctorErrors.map((e) => `${e.code}: ${e.message}`).join("; ").slice(0, 300)
  });
  let decisionFiles = [];
  try {
    decisionFiles = (await readdir3(path6.join(repoRoot, "project-memory/decisions"))).filter((f) => f.endsWith(".md"));
  } catch {
    decisionFiles = [];
  }
  const proposed = [];
  for (const f of decisionFiles) {
    try {
      const text = await readFile5(path6.join(repoRoot, "project-memory/decisions", f), "utf8");
      const fm = parseFrontMatter3(text);
      if (fm.status === "proposed") proposed.push(String(fm.id ?? f));
    } catch {
    }
  }
  gates.push({
    id: "G5",
    label: "No decisions left proposed",
    pass: proposed.length === 0,
    detail: proposed.length === 0 ? `${decisionFiles.length} decision(s) resolved` : proposed.join(", ")
  });
  let stateMd = "";
  try {
    stateMd = await readFile5(path6.join(repoRoot, "project-memory/STATE.md"), "utf8");
  } catch {
  }
  const stateLines = stateMd ? stateMd.split("\n").length : 0;
  gates.push({
    id: "G6",
    label: "STATE.md present and <= 60 lines",
    pass: stateLines > 0 && stateLines <= 60,
    detail: stateLines === 0 ? "STATE.md missing" : `${stateLines} lines`
  });
  return { done: gates.every((g) => g.pass), gates };
}
function formatDoneOutput(result) {
  const lines = [];
  lines.push(result.done ? "BATON: DONE" : "BATON: NOT DONE");
  lines.push("");
  for (const g of result.gates) {
    lines.push(`  [${g.pass ? "PASS" : "FAIL"}] ${g.id} ${g.label}`);
    lines.push(`         ${g.detail}`);
  }
  if (!result.done) {
    lines.push("");
    lines.push("Complete the failing gates, then re-run baton done.");
  }
  return lines.join("\n");
}

export {
  withLock,
  appendLedger,
  readLedger,
  nextEventId,
  nextClaimId,
  nextRunId,
  claimDedupeKey,
  replay,
  activeLeases,
  isMatch,
  overlaps,
  stale,
  formatStaleTable,
  conflicts,
  formatConflictsTable,
  doctor,
  formatDoctorOutput,
  done,
  formatDoneOutput
};
