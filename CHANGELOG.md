# Changelog

## 1.3.0 — Stage 5 Reach + orchestration primitives

### Reach
- `baton mcp` — MCP (Model Context Protocol) stdio server, JSON-RPC 2.0 over
  stdin/stdout. Tools: `baton_status`, `baton_task_list`, `baton_task_show`,
  `baton_packet`, `baton_search`, `baton_doctor`, `baton_log`,
  `baton_lease_take`, `baton_lease_list`, `baton_lease_release`. Read-dominant:
  workers pull truth and claim areas; verification stays in CLI/CI.
- `baton gate` — CI health gate: doctor + stale (dry-run) + unacknowledged
  conflicts + task flow. Exit 7 on failure. `--json` for machines,
  `--strict-done` to also require all `baton done` gates.
- `baton gate --init` — writes `.github/workflows/baton-gate.yml`; never
  overwrites an existing workflow.

### Retrieval
- `baton search <query>` — deterministic BM25 (k1=1.5, b=0.75) over the repo
  corpus. `never_include` respected, binary files skipped, corpus capped at
  2000 files / 64KB each, snippets secret-masked with the policy pattern set.
- `baton packet --search [--search-top N]` — new packet tier T5.5
  *retrieved*: BM25 snippets under `UNTRUSTED` markers, ordered below
  verified claims and above recent commits. Deterministic; no AI.

### Orchestration primitives
- `baton lease take|release|list` — area leases for deterministic
  multi-worker dispatch. Overlap uses the same static-prefix glob semantics
  as decision areas. `lease_acquired`/`lease_released` events in the ledger;
  TTL expiry recomputed by replay (leases survive restarts; audit trail
  intact). Overlapping take => exit 5 naming the blocking worker and task.
- `baton done` — computable definition of complete: six gates (all tasks
  done; zero stale claims; zero unacknowledged conflicts; doctor clean; no
  proposed decisions; STATE.md <= 60 lines). Exit 1 with a gate report when
  not done. `--json` for orchestrators.

### Internals
- Ledger schema: `lease_acquired`, `lease_released` events.
- ReplayState tracks leases; `activeLeases()` helper.
- Tests: 21 new integration tests (search ranking, never_include exclusion,
  snippet masking, lease roundtrip + overlap refusal, done gates, gate
  pass/init/idempotence, MCP handshake/tools/call/lease flow, packet
  retrieval tier). Total suite: 126 tests.
- Tests now resolve the CLI relative to the repo (no hardcoded build paths).
- Build: `tsup.config.ts` replaces fragile CLI banner flag.

## 1.2.0 — Stage 3 + Stage 4
- `stale`/`conflicts`/`status`/`status --html`/`log`/`doctor`.
- Worktree orphan GC on startup (never touches sibling `../wt-*` worker
  checkouts, G45).
- `task ready --allow-weak` / `--add-allowlist`; `report-check` strictness
  made unconditional.

## 1.1.1 — 14 P0 fixes
- P0-2 `prior_status` on blocked; P0-3 decision_status carries file hash;
  P0-4 verify_run carries base_commit; P0-5/6 claim dedupe keys; P0-7 packet
  secret scan; P0-8 O_EXCL ledger lock + fsync across the whole transaction;
  P0-9 worktree paths carry task id + pid; P0-11 rejected.follow_up_task as
  ID; P0-12 upgrade/migrate reserved (exit 4); P0-13 `strengthOf` check
  grading + `task lint`; P0-14 extended `never_include`; missing report =
  fail (not skip); `git config` forbidden in checks.

## 1.0.x — Stage 0
- Manual dogfood run: T-0001 accepted; T-0002 rejected (scope creep + report
  mismatch); T-0003 rejected (worker claimed 6/6 tests passing, verify showed
  2/6 — the founding incident for "reports are claims, checks decide truth").
