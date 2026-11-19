# Changelog

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
