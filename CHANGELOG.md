# Changelog

## 1.3.3 — Red-team findings: accept race + packet fence breakout

Independent red-team trial confirmed three findings. Two were mechanically
fixable; both landed test-first (15 new tests — suite at 238, ~54 s). The
third (check gaming) is inherent to test-based checking and is documented as
a known limit; the held-out-test design follows separately.

### accept binds to the exact verified commit (MEDIUM)
- Exploit: verify an honest commit (ALL_PASS), push a backdoor commit on top
  of the same branch — accept still said "accepted at <sha>" and never warned
  the branch had moved. A fast-forward passes the old on-branch
  `merge-base --is-ancestor` force-push check, and when accept ran from the
  base branch the old check never ran at all. The accepted event did record
  the verified SHA (merging that exact SHA was safe), but an operator merging
  the branch shipped unreviewed commits.
- Fix: accept resolves every `baton/<taskId>-*` branch and fails (exit 4)
  when any tip is NOT part of the verified head's history — catches both
  fast-forward movement and force-push rewrites, regardless of the checked-out
  branch. Remediation is re-verify at the new tip; accept then succeeds.
- `--allow-moved` is the explicit escape hatch: binds the accepted event to
  the verified commit and records `branch_moved: true` + `branch_tip` for the
  audit trail. Branch-behind-the-verified-head tips stay allowed (their
  content is a subset of the verified tree).

### packet fences cannot be broken from the inside (MEDIUM)
- Exploit: a file in `reads` containing the literal fence closer
  `--- END UNTRUSTED ---` closed the fence early; text after it (a fake
  "Task contract (TRUSTED)" block) appeared OUTSIDE the untrusted marker.
- Fix: all untrusted content — `reads`, `--include-files`, BM25 retrieval
  snippets, and worker-authored claim statements — is fence-escaped BEFORE
  the 8000-char cap. Any line that looks like a fence marker becomes a
  visible `[baton-escaped fence marker: ...]` line; mid-line dash+UNTRUSTED
  sequences are neutralized too, so the token sequence cannot survive anywhere
  in untrusted content and can neither close a block nor open a fake one.
  Honest content passes through byte-identical.
- The trusted packet header now documents the convention so a model reads
  escaped markers as file content, not trust boundaries.

### Known limitation (documented, not fixed here)
- Checks can be gamed: a worker can satisfy a weak check (hardcoded input,
  comment, empty file) while the goal is unmet — no check proves more than it
  asserts. Baton labels check strength (`behavior` vs `artifact`) honestly;
  the follow-up is a held-out test design, owned by the reviewer.

## 1.3.2 — Hardening the trust boundary

Second external review (tsc clean, 145/145 pass), verified gaps only. No new
features. Every item landed test-first; suite at 223 tests, ~53 s (was 253 s).

### P1 — secrets (`no_secrets`)
- New scanner patterns for real-world credentials that were verified MISSED:
  connection URLs with embedded credentials (`postgresql://user:pw@...`,
  quoted or unquoted), `sk-`-prefixed keys (OpenAI/Anthropic style), Google
  `AIza...` keys, JWTs (Supabase style), and unquoted `.env`-style assignments
  (`password = hunter2...`, case-insensitive).
- Obvious placeholders (`example`, `changeme`, `your_`, `xxxx`, `<...>`) are
  skipped per match, so example files stay clean.
- An ADDED `.env*` file fails `no_secrets` regardless of content — a committed
  env file is a leak waiting to happen even when today's values look innocent.

### P1 — execution sandbox (`cmd` checks run worker code)
- Every `cmd` run gets a throwaway `HOME`/`USERPROFILE`/`TMPDIR`/`TEMP`/`TMP`
  (created per run, deleted when it settles). Worker code can no longer read
  `~/.ssh`, `~/.npmrc`, `.aws/credentials`; `env_passthrough` cannot restore
  the real profile.
- `execution.sandbox: none | docker` in policy (default `none`). `docker`
  wraps checks in a container with no network and no mounted path except the
  worktree (requires `execution.docker_image`; missing image fails closed).
- `baton doctor` warns (`W_SANDBOX_NONE`) when commands are allowlisted but
  the sandbox is `none` outside CI.
- README gains a plain-language "Trust model" section recommending the CI gate
  on an ephemeral runner for untrusted code execution.

### P2 — check engine
- Allowlist matching is token-exact, not prefix-of-string: with
  `["node *","npm test *"]`, `nodemon x`, `node_evil x` and `npm testing-x`
  were all ALLOWED; now denied.
- Task YAML accepts `run` as an argv array (`run: [npm, test, --, -t, "a b"]`)
  so quoted arguments survive; the string form stays for simple commands.
  `shell: false` everywhere.
- `protected_paths` default now covers the files that define how tests run:
  `package.json` (scripts block only — dependency edits stay allowed),
  `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `pytest.ini`,
  `conftest.py`, `tox.ini`, `tsconfig*.json`, `Makefile`.

### P3 — smaller items
- Ledger tamper-evidence: entries carry `prev_hash` (computed hash of the
  entry appended after; `''` for genesis). Verification is fork-tolerant — a
  `prev_hash` must match some earlier entry — so a union merge of two branches
  that both appended stays valid (each references the common fork-tail).
  `doctor` reports `E_LEDGER_CHAIN_BREAK`; `doctor --fix` rebuilds the chain.
  Legacy ledgers without `prev_hash` stay clean.
- Windows: process-tree kill uses `taskkill /pid <pid> /T /F` (POSIX keeps the
  process-group kill).
- `pathExplicitlyAllowed` dead code removed; the ALWAYS_DENIED comment now
  states the real semantics (build artifacts are deny-unless-explicitly-
  allowed — tested both ways; `dist/` is committed in this repo).
- `baton workers` output is labeled ADVISORY: worker names come from
  self-declared report front matter, not from leases or the ledger writer.
- Test speed: dist build + cached template git fixture → suite 253 s → ~53 s.
- `npm audit`: fixed at source (`yaml` 2.9.1 runtime; `source-map-js`;
  `tsx` 4.23.15; `vitest` 2.1.9). Remaining advisories are dev-only majors
  (vitest 5, vite 6, zod 4) — documented, not upgraded (breaking changes).

### Compatibility
- File format unchanged (`baton_version: 1`); new policy fields default.
- Ledger `prev_hash` is optional — old ledgers verify clean; appends start
  chaining from the existing tail.
- The referee boundary holds: `.baton/**` and `.github/workflows/**` remain
  always-denied, `shell: false`, process-group kill, empty default allowlist,
  test restore from merge-base, and the MCP server still exposes no
  accept/reject tools.

## 1.3.1 — Tightening: merge repair, locked tests, portability

Hardening from the first external review. No new features — fixes to make the
existing ones safe under real multi-branch use.

### Ledger survives union merges (`baton doctor --fix`)
- Two worker branches that both append ledger events allocate the same event
  IDs from the same base; the `merge=union` driver (.gitattributes) then
  concatenates both sides into a ledger with duplicate IDs and broken
  monotonicity. This is now a tested, detected, repaired state:
  - `baton doctor` reports `E_DUPLICATE_EVENT_ID` (new) and
    `E_NON_INCREASING_ID` with a repair hint.
  - `baton doctor --fix` renumbers events in file order, remaps colliding
    claim IDs (c-XXXX) and run IDs (r-XXXX) consistently (first occurrence
    keeps the ID; each collision is a distinct claim/run from the other
    branch; follow-up events follow the most recent), and appends a
    `ledger_repaired` event recording exactly what changed.
  - Refuses to run when the ledger has malformed lines — repair never guesses.
- Integration tests reproduce the merge end-to-end (packet on both branches,
  real `git merge`, detection, repair, continued ID allocation) plus a
  synthetic claim/run collision remap.

### Workers are judged by the locked tests (`protected_paths`)
- A worker can no longer weaken the tests it is judged by. If the worker
  modifies a file matching `protected_paths` (new policy key; default:
  `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`) and the task does not
  set `allow_protected`, verify restores the merge-base versions into the
  worktree before running any check and adds a failing `protected_paths` row.
- Tasks that legitimately change tests: `baton task new --allow-protected`
  (stored in front matter, covered by the lock hash). Verify then runs the
  worker's versions and shows a passing `protected_paths` row with a note.
- `baton init` scaffolds `protected_paths` in policy.yml; set it to `[]` to
  disable.

### Naming + portability
- One name everywhere: the package is `baton` (repo `isaJrKai/baton`, binary
  `baton`). Install with `npm install -g github:isaJrKai/baton`; the GitHub
  Action is `isaJrKai/baton@v1`.
- Integration tests resolve the CLI relative to the test file instead of a
  hardcoded path — the suite now runs from any checkout (and in CI).
- README no longer claims the ledger is hash-chained: hashes cover artifacts
  (task locks, reports, packets, run logs); the ledger itself is append-only
  JSONL with strictly increasing IDs, and `doctor --fix` is the documented
  post-merge reconciliation step.


## 1.3.0 — Stage 5 Reach + orchestrator core (merged line)

This release merges two sibling v1.3.0 lines (the MCP/CI-gate build and the
leases/gate build) into one. The union keeps every feature from both and
removes none.

### Reach
- `baton mcp` — MCP (Model Context Protocol) stdio server, JSON-RPC 2.0 over
  stdin/stdout. Tools: `list_tasks`, `get_task`, `get_packet`, `status`,
  `stale`, `conflicts`, `doctor`, `search_events`, `search_files`,
  `next_task`, `project_done`, `list_workers`, `lease_take`, `lease_list`,
  `lease_release`, `gate`. Read-dominant: workers pull truth and claim areas;
  verification stays in CLI/CI (verify is never exposed over MCP — G21).
  Tool calls are serialized so ledger-writing tools cannot race.
- `baton gate` — CI health gate: doctor + stale (dry-run) + unacknowledged
  conflicts + task flow. Exit 7 on failure. `--json` for machines,
  `--strict-done` to also require all `baton done` gates.
- `baton gate --init` — writes `.github/workflows/baton-gate.yml`; never
  overwrites an existing workflow.
- GitHub Action `action.yml` (Baton Verify) + repo CI workflows from the
  v1.2 line remain the PR verification path.

### Retrieval
- `baton search <query>` — deterministic BM25 (k1=1.5, b=0.75) over the repo
  corpus (`--top`, `--glob`, `--json`). `never_include` respected, binaries
  skipped, per-file secret scan (files with findings are excluded entirely),
  human output carries an untrusted-content warning.
- `baton search` without a query keeps the v1.2 ledger event filter
  (`--task`, `--type`, `--last`, `--limit`, `--offset`).
- Packet tier T5.5 *retrieved* is on by default (`retrieval_snippets`, 0
  disables): BM25 snippets under `BEGIN/END UNTRUSTED` markers, ordered below
  verified claims and above recent commits; files already listed as `reads`
  are excluded. Deterministic; no AI, no network.

### Orchestrator core
- `baton next` — deterministic scheduler: oldest `ready` task whose
  dependencies are all `done` and whose touches don't overlap any in-flight
  task (assigned / in_review / needs_work). Prints queue + blocker reasons;
  exit 1 when nothing is eligible.
- `baton lease take|release|list` — area leases for deterministic
  multi-worker dispatch. Overlap uses the same static-prefix glob semantics
  as decision areas. `lease_acquired`/`lease_released` events in the ledger;
  TTL expiry recomputed by replay (leases survive restarts; audit trail
  intact). Overlapping take => exit 5 naming the blocking worker and task.
- `baton reject` twice on a task appends an `escalated` event automatically;
  escalated tasks are excluded from auto-dispatch and reported by `done` G7.
- `baton workers` — worker reputation derived from evidence: report front
  matter (`worker:`) joined with ledger outcomes. Score = 10·accepted −
  5·rejected − 1·verify_failures. `--json` for orchestrators.
- `baton done` — computable definition of complete, seven gates: (G1) all
  tasks done with rejected tasks passing only via a done follow-up, (G2) zero
  stale claims, (G3) zero unacknowledged conflicts, (G4) doctor clean, (G5)
  no proposed decisions, (G6) STATE.md <= 60 lines, (G7) no escalated tasks
  awaiting human review. Exit 1 with a gate report when not done. `--json`
  for orchestrators.

### Internals
- Ledger schema: `escalated`, `lease_acquired`, `lease_released` events
  (backward compatible — all optional additions).
- ReplayState tracks leases + escalation; `activeLeases()` helper.
- Policy schema gains `retrieval_snippets` (default 6, 0 disables).
- Packet retrieved tier emits snippets inside `BEGIN/END UNTRUSTED` markers.
- MCP tool calls execute sequentially (ledger-write safety).
- Tests: 139 passing (was 109 at v1.2.0). Coverage spans search ranking,
  never_include exclusion, secret exclusion, packet retrieval tier + policy
  knob, lease roundtrip + overlap refusal, done gates G1–G7, gate, MCP
  lease/gate tools, scheduler, escalation, reputation, full accept flow.

### Compatibility
- File format unchanged (`baton_version: 1`); `upgrade`/`migrate` still
  reserved (exit 4).
- Existing `.baton/policy.yml` files parse unchanged; the new
  `retrieval_snippets` field defaults.
- v1.2 P1 surface intact: `--rules-file`, `status --events/--ci/--html`,
  force-push detection, POSIX glob validation at ready time, zero-commit
  repo detection (`--git-dir`).

## 1.2.0 — Stage 3 + 4 (freshness, view) + Stage 5 MCP start
- staleness decay for verified claims, conflicts, status/log/doctor,
  status --html, worktree orphan GC, run logs, MCP server, CI matrix fix.

## 1.1.1 — 14 P0 changes (spec v1.1 + addendum)
- deterministic prior_status restore, O_EXCL ledger lock + fsync, worktree
  path hygiene, check strength classification, extended never_include,
  missing report = fail, no `git config` in checks, decision_status hashes.
