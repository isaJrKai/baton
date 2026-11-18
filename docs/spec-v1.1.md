<!-- Converted from Baton_Build_Specification_v1.1.docx (30 September 2026). -->
<!-- Revision document: v1.1 P0 fixes to the Baton v1.0 build specification. -->

# BATON — Build Specification v1.1

*Revision-marked — what changed from v1.0 and why*

Companion to "Baton: Build Specification" v1.0 (30 September 2026)

v1.1 · 30 September 2026

**Status: P0 fixes only. P1 and P2 fixes deferred to v1.2.**

Where this document and v1.0 disagree, this document wins for the listed changes only. All other v1.0 rules remain in force.

## 0. How to use this document

This is a revision document, not a full rewrite of v1.0. The builder should read v1.0 in full first, then read this document to apply the listed P0 fixes. Each fix has:

- An ID (P0-1 through P0-12) for cross-reference in stage reports and QUESTIONS.md.
- A type: ADDITIVE (new optional field or new reserved command, no existing behavior changes), or BREAKING (a field is added to an event schema, a dedupe key changes, semantics change, or an implementation contract tightens).
- The v1.0 location it modifies.
- A rationale — why this change is necessary, what bug or gap it closes.
- Old text from v1.0 (verbatim) and new text for v1.1.

P1 and P2 fixes are intentionally out of scope for v1.1 and will be addressed in v1.2 after the builder has had a chance to integrate these P0 changes and report back.

**Rules for the builder:**

- Read v1.0 sections 1–3 completely before reading this document.
- Apply each P0 change in order. Do not skip a change because it seems minor.
- If a change is ambiguous, write the question in QUESTIONS.md and continue only with work the question does not affect.
- Stage reports from v1.1 onward must list each P0 change as applied or pending.

*Owners: do not accept a stage report that lists any P0 change as pending without a clear blocker. The P0 list is the floor, not the ceiling.*

## 1. Summary of P0 changes

Twelve changes. Seven are BREAKING (event schemas, dedupe keys, semantics, implementation contracts). Five are ADDITIVE. Builders must apply all twelve before starting Stage 1 code.

| ID | Change | Type | Location in v1.0 |
|---|---|---|---|
| P0-1 | Add `description` field to Check schema | ADDITIVE | §3.3 (Task / Check union type) |
| P0-2 | Add `prior_status` to `blocked` ledger event | BREAKING (event schema) | §3.4 / TABLE 2 row 11 (blocked / unblocked) |
| P0-3 | Add `hash` to `decision_status` ledger event | BREAKING (event schema) | §3.4 / TABLE 2 row 12 (decision_status) |
| P0-4 | Add `base_commit` to `verify_run` ledger event | BREAKING (event schema) | §3.4 / TABLE 2 row 6 (verify_run) |
| P0-5 | Fix `claim` dedupe key (task + statement + key) | BREAKING (dedupe) | §3.4 / TABLE 2 row 5 (claim) |
| P0-6 | Fix `claim_status` dedupe key (use run_id, not reason) | BREAKING (dedupe) | §3.4 / TABLE 2 row 8 (claim_status) |
| P0-7 | `report_matches`: missing report is `fail`, not `skip` | BREAKING (semantics) | §6.4 (verify logic) + §6.5 / TABLE 4 row 7 (report_matches) + §6.7 ("Missing report means skip...") |
| P0-8 | Lock held for entire ledger write transaction + fsync | BREAKING (implementation) | §2.3 / G11 (filesystem safety) + §3.4 (ledger append) |
| P0-9 | Worktree path includes task ID and PID | BREAKING (implementation) | §6.4 (verify logic) + G8 (git safety) |
| P0-10 | Allow `git worktree list` and `git rev-parse --verify` in G6; forbid `git config` | BREAKING (security boundary) | §2.2 / G6 (git wrapper allowlist) |
| P0-11 | Add `follow_up_task?: string` to `rejected` ledger event | BREAKING (event schema) | §3.4 / TABLE 2 row 10 (rejected) |
| P0-12 | `baton upgrade` and `baton migrate` reserved (exit 4) | ADDITIVE | §9 (CLI reference) — new reserved commands |

**Type legend:**

- ADDITIVE — new optional field, new reserved command, or new allowlisted git subcommand. Existing v1.0 task files, decisions, and reports continue to validate. No replay behavior changes.
- BREAKING (event schema) — a field is added to a ledger event type. Old ledger lines without the new field will fail strict Zod parsing. Builders must add a forward-compatibility reader that supplies defaults for legacy lines (see §3 below).
- BREAKING (dedupe) — the dedupe key for an event type changes. Re-running an idempotent command on a v1.0 ledger may now produce new events where v1.0 would have suppressed them. This is correct behavior, not a bug.
- BREAKING (semantics) — the behavior of `report_matches` changes from skip-on-missing to fail-on-missing. v1.0 ledgers are unaffected (no events are rewritten), but `verify` invocations against the same task+head produce different verdicts.
- BREAKING (implementation) — a contract in §2 (Global precautions) is tightened. The git wrapper, lock semantics, or worktree path format changes. Builders must update io/git.ts and io/lock.ts accordingly.
- BREAKING (security boundary) — the G6 allowlist or G7 denylist changes. The wrapper must be updated and the security tests extended.

## 2. Legacy ledger compatibility

Several P0 changes add fields to existing ledger event types (P0-2, P0-3, P0-4, P0-5, P0-6, P0-11). v1.0 ledgers in production will have lines without these fields. The builder must implement a forward-compatibility reader:

- Read each line as raw JSON without schema validation.
- If the event type has a v1.1 schema with new required fields, supply defaults per the table below.
- Pass the normalized line through Zod validation.
- If validation still fails, treat the line as malformed (§3.4 rule: every command except doctor exits 3).

**Defaults for legacy lines:**

- **P0-2 `blocked.prior_status`** — default: `"ready"` (most common prior state). Doctor warning: "legacy blocked event without prior_status".
- **P0-3 `decision_status.hash`** — default: `""` (empty string; treated as unknown). Doctor warning: "legacy decision_status without hash".
- **P0-4 `verify_run.base_commit`** — default: derive from `git merge-base <base> <head_commit>` at read time (deterministic given current base).
- **P0-5 claim dedupe key** — default: task + statement + `""` (preserves v1.0 behavior for keyless claims).
- **P0-6 `claim_status.run_id`** — default: `""` (empty string; treated as pre-verify transition, e.g. emitted by `baton stale`).
- **P0-11 `rejected.follow_up_task`** — default: derive from `baton log --task <task>` walk to find the follow-up task by body link.

The defaults are deliberately conservative: they preserve v1.0 behavior for legacy lines while letting v1.1 commands run. `baton doctor` must report counts of legacy-normalized lines so the human knows migration is incomplete.

Migration path: once the human is confident no v1.0 lines remain in active use, `baton upgrade` (P0-12, reserved) in a future v2 will rewrite the ledger in place with the new fields populated from the defaults above.

## 3. P0 changes — detailed

### P0-1 · Add `description` field to Check schema

**Type:** ADDITIVE

**Location in v1.0:** §3.3 (Task / Check union type)

**Rationale:**

The verdict table prints check results by `id`. Without a human-readable description, `scope` vs `c-0001` is meaningless to the human reviewing `verify` output. The field is optional so existing task files continue to validate; new task authors are nudged to fill it in.

**v1.0 (old):**

```ts
type Check =
| { id: string; type: 'cmd'; run: string; covers?: string[]; watch?: string[] }
| { id: string; type: 'diff_scope'; allow: string[] }
| { id: string; type: 'grep'; file: string; pattern: string;
  mode?: 'must_match' | 'must_not_match'; covers?: string[]; watch?: string[] }
| { id: string; type: 'file_exists'; path: string; exists?: boolean;
  covers?: string[]; watch?: string[] }
| { id: string; type: 'contract'; file: string;
  expect?: 'changed' | 'unchanged' | 'either'; covers?: string[]; watch?: string[] }
| { id: string; type: 'no_secrets' };
```

**v1.1 (new):**

```ts
type Check =
| { id: string; description?: string; // 1..120 chars, shown in verdict table
  type: 'cmd'; run: string; covers?: string[]; watch?: string[] }
| { id: string; description?: string;
  type: 'diff_scope'; allow: string[] }
| { id: string; description?: string;
  type: 'grep'; file: string; pattern: string;
  mode?: 'must_match' | 'must_not_match'; covers?: string[]; watch?: string[] }
| { id: string; description?: string;
  type: 'file_exists'; path: string; exists?: boolean;
  covers?: string[]; watch?: string[] }
| { id: string; description?: string;
  type: 'contract'; file: string;
  expect?: 'changed' | 'unchanged' | 'either'; covers?: string[]; watch?: string[] }
| { id: string; description?: string;
  type: 'no_secrets' };
```

### P0-2 · Add `prior_status` to `blocked` ledger event

**Type:** BREAKING (event schema)

**Location in v1.0:** §3.4 / TABLE 2 row 11 (blocked / unblocked)

**Rationale:**

TABLE 3 row 7 says `unblocked` returns the task to its prior status, but the prior status is not recorded on the `blocked` event. Walking back through the ledger is O(n) and ambiguous if there were intervening `verify_run` events (e.g., ready → blocked → unblocked should restore `ready`, but a walk-back might land on `assigned` if the worker pushed a branch during the blocked window). Storing `prior_status` on the `blocked` event makes the state machine deterministic and the replay logic a pure function of the single event.

**v1.0 (old):**

```text
blocked, unblocked task, reason none
```

**v1.1 (new):**

```text
blocked task, prior_status, reason none
unblocked task, reason none

// prior_status: the task's derived status immediately before this blocked event.
// unblocked restores the task to the prior_status recorded on the most recent
// blocked event for this task. If no prior_status is found (legacy ledger
// lines), fall back to walking the ledger; emit a doctor warning.
```

### P0-3 · Add `hash` to `decision_status` ledger event

**Type:** BREAKING (event schema)

**Location in v1.0:** §3.4 / TABLE 2 row 12 (decision_status)

**Rationale:**

Without the file hash at the moment of `accept`, there is no way to detect that a decision file was edited after acceptance. This mirrors the existing `task_locked.hash` protection for task files (G17). Decision files are human-authored (not worker-authored), so this is not a security boundary — it is a provenance and audit property. The hash is sha256 of the decision file bytes on the base branch at the moment of the transition.

**v1.0 (old):**

```text
decision_status decision, from, to none
```

**v1.1 (new):**

```text
decision_status decision, from, to, hash none

// hash: sha256 of project-memory/decisions/<D-id>.md bytes on the base branch
// at the moment of this transition. Used by `baton doctor` to detect
// post-accept edits to decision files.
```

### P0-4 · Add `base_commit` to `verify_run` ledger event

**Type:** BREAKING (event schema)

**Location in v1.0:** §3.4 / TABLE 2 row 6 (verify_run)

**Rationale:**

The existing event records `head_commit` but not `base_commit`. Without it, `baton stale` cannot reason about base movement — a verified claim's anchor references a commit that may no longer be reachable from the current base tip. `base_commit` on `verify_run` lets staleness compare the verify-time base to the current base tip and emit `branch_moved` correctly when the base has advanced past the verify-time base. It also lets `baton doctor` detect verify events against a stale base (e.g., the human forgot to rebase before verifying).

**v1.0 (old):**

```text
verify_run run_id (r- plus 4 digits), task, head_commit, verdict none
```

**v1.1 (new):**

```text
verify_run run_id (r- plus 4 digits), task, base_commit, head_commit, verdict none

// base_commit: the base branch tip at the moment verify was invoked
// (git rev-parse <base>). Used by staleness to detect base movement and
// by doctor to detect verifies run against a stale base.
```

### P0-5 · Fix `claim` dedupe key (task + statement + key)

**Type:** BREAKING (dedupe)

**Location in v1.0:** §3.4 / TABLE 2 row 5 (claim)

**Rationale:**

The v1.0 dedupe key is `task + statement`. Two reports with the same statement text but different `key` fields would be silently deduped to one — losing a claim. Statement text is not a natural key: a worker copy-pasting a claim wording for a different concern will unintentionally suppress the second claim. Including `key` in the dedupe makes it correct: identical statements on the same key are genuinely duplicates; identical statements on different keys are distinct claims.

**v1.0 (old):**

```text
claim claim_id (c- plus 4 digits), task, statement, key?, report_sha256 task + statement
```

**v1.1 (new):**

```text
claim claim_id (c- plus 4 digits), task, statement, key?, report_sha256 task + statement + key

// Dedupe key uses the optional key field. If key is absent (claim has no key),
// the dedupe key is task + statement + "" (effectively task + statement,
// preserving v1.0 behavior for keyless claims).
```

### P0-6 · Fix `claim_status` dedupe key (use run_id, not reason)

**Type:** BREAKING (dedupe)

**Location in v1.0:** §3.4 / TABLE 2 row 8 (claim_status)

**Rationale:**

The v1.0 dedupe key is `claim_id + status + anchor commit`. The reviewer proposed adding `reason`, but `reason` is free-text and itself fragile as a key component. The actual edge case is a claim that flips `verified → stale → verified` on the same anchor — for example, a file reverted to its prior content after a refactor. That edge case is correctly captured by including `run_id` (the verify run that produced the status transition), not by including the reason string. Two transitions with different `run_id` are distinct events even if their other fields match.

**v1.0 (old):**

```text
claim_status claim_id, status (verified, failed, stale), anchor?, reason claim_id + status + anchor commit
```

**v1.1 (new):**

```text
claim_status claim_id, status (verified, failed, stale), anchor?, reason, run_id? claim_id + status + anchor.commit + run_id

// run_id is the verify_run that produced this transition (absent for
// `stale` events emitted by `baton stale`, which are not tied to a verify).
// Two transitions with different run_ids are distinct events even if
// status and anchor match.
```

### P0-7 · `report_matches`: missing report is `fail`, not `skip`

**Type:** BREAKING (semantics)

**Location in v1.0:** §6.4 (verify logic) + §6.5 / TABLE 4 row 7 (report_matches) + §6.7 ("Missing report means skip...")

**Rationale:**

v1.0 makes a missing report a `skip`, producing verdict `incomplete`, which blocks `accept` without `--override`. That is correct in effect but wrong in signal: `incomplete` sounds optional, `has_failures` sounds broken. Workers will learn the wrong lesson from `incomplete`. The fix is to make missing-report a `fail` with a clear reason, producing `has_failures`. This puts report absence on the same footing as a failing check — because functionally, a task with no report has no claims recorded, no `not_done` surfaced, no `questions` raised, and the next packet's T5 (verified facts) tier starves. The `--strict` flag on `baton report check` is removed: there is now one way to fail, not two.

**v1.0 (old):**

```text
// §6.4 verify logic
verdict = any fail ? has_failures
        : any skip ? incomplete
        : all_pass

// TABLE 4 row 7
report_matches  Report changed_files equals the diff path set.
                Skip if no report exists. Fail if head_commit in the
                report differs from the verified head.

// §6.7
Missing report means skip, so the verdict is `incomplete` and accept is
blocked without override.
```

**v1.1 (new):**

```text
// §6.4 verify logic
verdict = any fail ? has_failures
        : any skip ? incomplete   // only `cmd` checks skipped due to
        : all_pass                // non-acknowledged execution

// TABLE 4 row 7
report_matches  Report changed_files equals the diff path set.
                If no report exists at project-memory/reports/R-*.md on
                branch <head>: result = fail, reason = "no report — claims
                not recorded, questions not surfaced". Verdict becomes
                has_failures.
                If report exists with empty claims[]: result = pass.
                Fail if head_commit in the report differs from the
                verified head.

// §6.7
Missing report means fail (not skip), so the verdict is `has_failures`
and accept is blocked without override. `incomplete` is reserved for the
case where `cmd` checks were skipped due to non-acknowledged execution
(G21).

// `baton report check` --strict flag is removed. report check is always
// strict about set equality; `verify`'s report_matches is the gate.
```

### P0-8 · Lock held for entire ledger write transaction + fsync

**Type:** BREAKING (implementation)

**Location in v1.0:** §2.3 / G11 (filesystem safety) + §3.4 (ledger append)

**Rationale:**

G11 v1.0 says "Ledger append is one complete line per write, guarded by a .baton/lock file so two processes cannot interleave." This is underspecified. `fs.appendFile` is NOT atomic on Windows and not atomic across processes on any OS without locking. The lock must be held for the entire transaction: `read ledger → allocate next id → append line → fsync → release lock`. Without fsync, a power loss can leave a truncated line that breaks every command except `doctor` (per §3.4 replay rule). The lock file must be `O_EXCL` create + `fsync` of the directory on first creation; subsequent writers retry with backoff.

**v1.0 (old):**

```text
G11. Writes are atomic: write a temp file in the same folder, then rename.
Ledger append is one complete line per write, guarded by a .baton/lock
file so two processes cannot interleave.
```

**v1.1 (new):**

```text
G11. Writes are atomic: write a temp file in the same folder, then rename.
Ledger append is one complete line per write, guarded by a .baton/lock
file (O_EXCL create) held for the entire transaction:
  open(ledger, 'a') → read tail to confirm last id →
  write(line + '\n') → fsync(ledger fd) → fsync(dir fd) →
  close → unlink(.baton/lock).
The lock is held across the read-write-fsync cycle, not just for ID
allocation. On Windows, fsync via fs.fsyncSync on the file descriptor;
directory fsync is not supported, document this as a known gap.
`baton doctor` detects and offers to truncate a corrupted final line.
```

### P0-9 · Worktree path includes task ID and PID

**Type:** BREAKING (implementation)

**Location in v1.0:** §6.4 (verify logic) + G8 (git safety)

**Rationale:**

v1.0 uses `.baton/tmp/wt-<runId>`. Two `verify` invocations for different tasks running concurrently can produce the same runId if the ID allocator is contested under load. Including the task ID and process PID in the worktree path eliminates the collision class entirely. PID also lets `baton doctor` detect worktrees whose parent process has died (the worktree exists but the PID is no longer alive) and clean them up safely.

**v1.0 (old):**

```text
// §6.4
wt = git worktree add --detach .baton/tmp/wt-<runId> <head>

// G8
Verification runs only in a temporary detached worktree under .baton/tmp/,
never in the user's working directory. Remove it in a finally block. On
startup, remove stale worktrees Baton itself created.
```

**v1.1 (new):**

```text
// §6.4
wt = git worktree add --detach .baton/tmp/wt-<taskId>-<runId>-<pid> <head>

// G8
Verification runs only in a temporary detached worktree under .baton/tmp/,
never in the user's working directory. Path format: wt-<taskId>-<runId>-<pid>,
e.g. wt-T-0007-r-0044-98213. Remove it in a finally block. On startup,
`baton doctor` lists worktrees via `git worktree list` (newly allowlisted
in G6) and removes any whose path matches wt-* and whose PID is no longer
alive. Stale worktrees with live PIDs are reported but not removed.
```

### P0-10 · Allow `git worktree list` and `git rev-parse --verify` in G6; forbid `git config`

**Type:** BREAKING (security boundary)

**Location in v1.0:** §2.2 / G6 (git wrapper allowlist)

**Rationale:**

Three corrections to the git allowlist. (1) `worktree list` is needed by `baton doctor` to detect stale worktrees left by killed `verify` runs — without it, the cleanup in P0-9 cannot be implemented. (2) `rev-parse --verify` is needed to disambiguate branch existence checks; bare `rev-parse` is ambiguous when the argument is missing. (3) `git config` must be explicitly forbidden: a compromised worker could otherwise influence `git show <base>:...` behavior via `core.hooksPath` if Baton ever executes git with `HOME` passthrough. Listing it as forbidden (rather than merely absent from the allowlist) makes the security boundary auditable.

**v1.0 (old):**

```text
G6. All git access goes through one wrapper that allows only:
rev-parse, diff, log, show, ls-files, ls-tree, cat-file, merge-base,
for-each-ref, status --porcelain, worktree add --detach,
worktree remove --force.
Anything else is a bug.

G7. Baton never runs commit, push, merge, rebase, reset, checkout, clean,
stash, or anything that changes refs or config.
```

**v1.1 (new):**

```text
G6. All git access goes through one wrapper that allows only:
rev-parse [--verify permitted], diff, log, show, ls-files, ls-tree,
cat-file, merge-base, for-each-ref, status --porcelain,
worktree add --detach, worktree remove --force, worktree list.
Anything else is a bug.

G7. Baton never runs commit, push, merge, rebase, reset, checkout, clean,
stash, config, or anything that changes refs, config, or hooks.
`git config` is explicitly forbidden: a compromised worker could
otherwise influence `git show <base>:...` behavior via `core.hooksPath`
if Baton ever executes git with HOME passthrough.
```

### P0-11 · Add `follow_up_task?: string` to `rejected` ledger event

**Type:** BREAKING (event schema)

**Location in v1.0:** §3.4 / TABLE 2 row 10 (rejected)

**Rationale:**

v1.0 records `follow_up?` as a boolean. The follow-up task already links back to the rejected task in its body (§6.6: "With --follow-up it creates a new draft task with a line in its body linking the rejected task"). The rejected event should link forward to the new task ID. This makes the ledger a navigable graph: `baton log --task T-0007` can show "rejected → spawned T-0008" as a forward edge. One-line schema fix, belongs with the other event-payload gaps (P0-2, P0-3, P0-4).

**v1.0 (old):**

```text
rejected task, reason, follow_up? none
```

**v1.1 (new):**

```text
rejected task, reason, follow_up_task? none

// follow_up_task: the ID of the new task created by --follow-up, if any.
// Empty/absent if --follow-up was not passed. Lets `baton log` render the
// task graph as a forward edge: rejected T-0007 → spawned T-0008.
```

### P0-12 · `baton upgrade` and `baton migrate` reserved (exit 4)

**Type:** ADDITIVE

**Location in v1.0:** §9 (CLI reference) — new reserved commands

**Rationale:**

v1.0 has no migration path. When v2 ships (changing `baton_version: 1` → `baton_version: 2` on file formats), users will need a `baton upgrade` command. Reserving the command now means scripts that grep for `baton` subcommands will see it exists and not silently mis-route. The reserved form exits 4 with a clear message; v2 will implement the actual migration.

**v1.0 (old):**

```text
// (no entry in §9 CLI reference for upgrade or migrate)
```

**v1.1 (new):**

```text
// §9 CLI reference — new entries:
baton upgrade   Reserved. Exits 4 with: "migration not needed at v1;
                files carry baton_version: 1".
baton migrate   Alias of `baton upgrade`. Same exit 4 message.

// v2 will implement in-place migration of all project-memory/ files
// and ledger.jsonl from baton_version 1 → 2, with a git-tracked backup.
```

## 4. Impact on each stage

**These P0 fixes touch every stage. The builder should incorporate them before starting the relevant stage.**

### Stage 0 (Templates)

- No impact. Templates use only the schemas already present in v1.0. The new optional `description` field on Check (P0-1) can be added to the task template as a comment, but is not required.

### Stage 1 (Packets)

- P0-1: Add `description?` to Check Zod schema. Update task template (Appendix A4) to include a `description:` line for each check as a comment.
- P0-8: Implement lock in io/lock.ts as O_EXCL create + hold across read-write-fsync cycle. Add fsync after every ledger append.
- P0-12: Wire `baton upgrade` and `baton migrate` as no-op commands that exit 4 with the v1.1 message.

### Stage 2 (Verify)

- P0-7: Change `report_matches` from skip-on-missing to fail-on-missing. Update verdict computation in core/verdicts.ts.
- P0-9: Update worktree path format in io/git.ts to wt-\<taskId\>-\<runId\>-\<pid\>.
- P0-10: Update git wrapper allowlist in io/git.ts. Add `worktree list` and `rev-parse --verify`. Add `config` to the explicit denylist in G7.
- Update security tests: (a) worker edits its own task file → verify still reads base branch (existing v1.0 test, retained); (b) worker attempts to set core.hooksPath via `git config` → blocked by G7.

### Stage 3 (Freshness)

- P0-2: Implement `prior_status` lookup from `blocked` event (no ledger walk-back).
- P0-3: Add hash check to `decide accept` (file hash must equal proposed-time hash).
- P0-4: Use `verify_run.base_commit` in staleness comparison (no longer need to derive from merge-base).
- P0-5, P0-6: Update dedupe logic in ledger-replay.ts to use new keys.
- P0-11: `baton log --task T-0007` can now render the follow-up task ID as a forward edge.
- P0-7 (carry-over): `baton stale` does not emit `claim_status stale` for claims that were never `verified` — but with P0-7, claims can never be `verified` without a report, so this is now consistent.

### Stage 4 (View)

- P0-1: `baton status --html` and `baton verify` output render `description` alongside `id` in the checks table.
- P0-11: `baton log` view shows follow-up task IDs as links.

### Stage 5 (Reach)

- No direct impact. GitHub Action and MCP server consume the same ledger, schemas, and CLI.

## 5. Manual acceptance for v1.1 integration

**The builder must demonstrate each P0 change with a manual acceptance step. Each step produces an observable artifact: a ledger line, a doctor warning, a verdict, or an error message.**

### P0-1 (Check.description)

- Create a task with `{id: scope, description: "Only files under src/api/tasks/**", type: diff_scope, allow: ["src/api/tasks/**"]}`.
- Run `baton verify T-0001`. Confirm the verdict table renders `scope (Only files under src/api/tasks/**) — pass`, not bare `scope — pass`.

### P0-2 (blocked.prior_status)

- Lock T-0001, dispatch, verify green → status `in_review`.
- Run `baton task block T-0001 --reason "waiting on vendor"`. Confirm ledger line includes `prior_status: "in_review"`.
- Run `baton task unblock T-0001 --reason "vendor replied"`. Confirm status returns to `in_review`, not `ready` or `assigned`.

### P0-3 (decision_status.hash)

- Create decision D-0001 (proposed). Record its file hash.
- Edit D-0001.md body (change a sentence in the "Why" section).
- Run `baton decide accept D-0001`. Confirm exit 4 with error: "decision file changed since proposed: locked \<hash\>, current \<hash\>".

### P0-4 (verify_run.base_commit)

- Run `baton verify T-0001` against base `a1b2c3d` and head `e4f5a6b`.
- Inspect the ledger line. Confirm it contains `base_commit: "a1b2c3d"`, not just `head_commit: "e4f5a6b"`.

### P0-5 (claim dedupe)

- Submit two reports for T-0001 with the same statement text but different keys: `{statement: "X works", key: "a.b"}` and `{statement: "X works", key: "c.d"}`.
- Confirm the ledger has two `claim` events, not one.

### P0-6 (claim_status dedupe)

- Verify T-0001 → claim c-0001 goes `reported → verified` (run_id r-0044).
- Edit a watched file, run `baton stale` → c-0001 goes `verified → stale` (no run_id).
- Revert the file, run `baton verify T-0001` again → c-0001 goes `stale → verified` (run_id r-0045).
- Confirm three distinct `claim_status` events in the ledger (dedupe keys differ by run_id).

### P0-7 (report_matches fail)

- Dispatch T-0001. Have the worker complete the work but NOT write a report.
- Run `baton verify T-0001`. Confirm exit 6, verdict `has_failures`, `report_matches` row shows `fail` with reason `no report — claims not recorded, questions not surfaced`.
- Confirm `baton accept T-0001` is blocked (exit 4) without `--override`.

### P0-8 (lock + fsync)

- Run `baton verify T-0001` and `baton verify T-0002` concurrently from two terminals.
- Confirm no ledger corruption (run `baton doctor`, expect zero errors).
- Inspect ledger — confirm no interleaved or truncated lines.

### P0-9 (worktree path)

- Run `baton verify T-0001`. During the run, list `.baton/tmp/`. Confirm a directory `wt-T-0001-r-0044-\<pid\>` exists (where \<pid\> is the verifying process's PID).
- After verify completes, confirm the directory is gone.
- Kill a `baton verify` mid-run (Ctrl+C). Run `baton doctor`. Confirm it lists the orphan worktree and removes it (PID no longer alive).

### P0-10 (git allowlist)

- Attempt to call `git config core.hooksPath /tmp/evil` from a `cmd` check. Confirm it is rejected by the wrapper.
- Confirm `baton doctor` runs `git worktree list` (allowlisted) to detect orphan worktrees.

### P0-11 (rejected.follow_up_task)

- Dispatch T-0001. Verify fails. Run `baton reject T-0001 --reason "scope creep" --follow-up "Redo with correct scope"`.
- Confirm ledger line contains `follow_up_task: "T-0002"`.
- Run `baton log --task T-0001`. Confirm output shows `rejected → spawned T-0002`.

### P0-12 (upgrade / migrate reserved)

- Run `baton upgrade`. Confirm exit 4 with message: `migration not needed at v1; files carry baton_version: 1`.
- Run `baton migrate`. Same exit 4 and message.

*If any acceptance step does not produce the stated output, the P0 change is not done. The builder must report it as pending in the stage report with a clear blocker.*

## 6. Deferred to v1.2 (P1) and v1.3 (P2)

*The reviewer's full fix list contained P1 and P2 items beyond the P0 set. They are out of scope for v1.1 but listed here for traceability.*

### P1 (target v1.2)

- Add `baton task lint` (or fold into `task ready` warning block) — check strength classification: `cmd` > `contract` > `grep`/`file_exists` > `diff_scope`/`no_secrets`.
- Add `baton log [--task] [--type] [--last N]` command.
- Add `baton task list/show` for CLI parity with MCP `list_tasks`.
- Implement `allowed_commands` ` *` suffix forbidden-char check.
- Implement `touches` POSIX normalization at `task ready` (reject backslashes).
- Implement per-file secret scan + `never_include` before `--include-files` inclusion, with 8k cap per file (matches T2).
- Add `--limit`/`--offset` to `baton search`.
- Add `--unack` to `baton conflicts`.
- Document `--ci` summary format (Markdown table with `<!-- baton:ci -->` marker).
- Improve `accept` error message after force-push (suggest `baton verify T-XXXX --head <new-tip>`).
- Add `--rules-file <path>` flag to `baton init` (for `.cursorrules`, `.github/copilot-instructions.md`, etc.).
- Add `--events N` flag to `baton status --html`.

### P2 (target v1.3)

- Lower HTML size warning from 5 MB to 1 MB.
- Clarify G14 vs doctor STATE.md limits (60 lines practical, 200 KB absolute cap).
- Clarify Windows path handling for `touches` globs.
- Document ledger growth expectation and add replay cache if needed.
- Document that `merge=union` on `ledger.jsonl` breaks at 5-person teams (multi-user hosting remains out of scope).
- Specify Stage 6 "patterns" command if trial data shows repeated worker failure modes.
- Implement `baton upgrade` actual migration logic for v2 file format changes.
