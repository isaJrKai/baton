# BATON

**Repo-native continuity and verification kit for AI-assisted development.**

Baton lets you hand coding work to AI workers with a simple contract: **reports are claims, checks decide truth.** A worker model saying "all tests pass" means nothing; a test run decides everything.

```
             ┌────────────────────────────────────────────────┐
             │  baton task new → ready → packet               │
             │  (scope, checks, context brief, trusted header)│
             └───────────────────────┬────────────────────────┘
                                     │ paste packet / MCP
                              ┌──────▼──────┐
                              │  AI worker  │  Claude / GPT / Cursor / ...
                              │ own branch  │
                              └──────┬──────┘
             ┌───────────────────────▼────────────────────────┐
             │  baton report check → verify → accept / reject │
             │  (tests run, diff scope, greps, secrets, ledger)│
             └────────────────────────────────────────────────┘
```

## Why

Handing a task to an AI model today works like this: you paste a long briefing, the model edits files, and it tells you it is done. Sometimes it is lying — the Stage 0 trial caught a worker claiming "All tests pass" when 2 of 6 tests failed. Baton replaces that trust with mechanics:

1. **Packets** — the task compiles into a short structured brief (250–1100 tokens vs 2000–3000 freeform) with a trusted header, constraints, decisions, and an explicit `Omitted:` footer for everything cut.
2. **Checks** — every task carries mechanical checks: `cmd` (run tests), `diff_scope` (only allowed files may change), `grep` (must / must-not match), `file_exists`, `contract`, `no_secrets`, `report_matches`.
3. **Ledger** — every event (packet issued, claim made, check result, accept/reject) is an append-only line in `project-memory/ledger.jsonl`, replayable for audit. Hashes cover the artifacts (task locks, reports, packets, run logs); the ledger itself is append-only JSONL with strictly increasing IDs, and `baton doctor --fix` is the documented reconciliation step after merging diverged branches.
4. **Memory** — `project-memory/` carries state (STATE.md), doctrine (DECISIONS.md), evidence (claims + ledger), and provenance (git history). Freshness decays: when anchor files change, verified claims go `stale`.

## Quickstart

```bash
npm install -g github:isaJrKai/baton
baton init                      # scaffold project-memory/, .baton/policy.yml, pointer blocks

baton decide "Globs use picomatch with dot:true" --key core.globs --areas "src/core/**"
baton decide accept D-0001

baton task new "Implement src/core/globs.ts" --touches "src/core/globs.ts,test/globs.test.ts"
# edit project-memory/tasks/T-0001.md — objective, checks, reads
git add project-memory/tasks/T-0001.md && git commit -m "task T-0001"
baton task ready T-0001         # locks the task (hash + base commit recorded)

baton packet T-0001             # prints/writes the worker brief
# hand the packet to any AI worker; it works on its own branch and writes
# project-memory/reports/R-XXXX.md with its claims

baton report check project-memory/reports/R-0001.md
baton verify T-0001             # runs the checks; prints the verdict table
baton accept T-0001             # or: baton reject T-0001 --reason "..." --follow-up "..."
```

Baton never merges. Accept records the verdict; merge through your normal PR process.

## Commands

| Command | Purpose |
| --- | --- |
| `baton init` | Scaffold `project-memory/`, `.baton/policy.yml`, pointer blocks. `--rules-file <path>` also writes the pointer to `.cursorrules` etc. |
| `baton decide` / `decide accept\|reject` | Record architectural decisions with `areas` (globs) |
| `baton task new\|ready\|list\|show\|lint\|block\|unblock\|unlock` | Task lifecycle; `ready` locks with hash; `lint` shows check strength; `new --allow-protected` lets the task change test files |
| `baton packet <T-id>` | Compile the worker brief under a token budget |
| `baton report check <path>` | Validate a closeout report against the real diff |
| `baton verify <T-id>` | Run all checks in a detached worktree; verdict table with check strength |
| `baton accept / reject` | Close out a task; reject spawns follow-up tasks |
| `baton stale` | Claims whose anchor files changed since verification |
| `baton conflicts` | Decision and claim conflicts (`--ack` / `--unack`) |
| `baton status` | Summary; `--html` single-file page; `--ci` Markdown table for PR comments |
| `baton doctor` | Structural integrity: ledger, hashes, duplicates, orphan worktrees. `--fix` repairs ledger ID collisions from merged branches |
| `baton log` | Ledger history |
| `baton search <query>` | v1.3: BM25 retrieval over repo files (`--top`, `--glob`, `--json`). Without a query: filtered ledger search (`--task`, `--type`, `--last`, `--limit`, `--offset`) |
| `baton next` | v1.3: deterministic scheduler — next eligible task (deps done, no area conflict with in-flight work) |
| `baton lease take\|release\|list` | v1.3: exclusive area leases with TTL (`lease_acquired` / `lease_released` events; expiry recomputed by replay) |
| `baton done` | v1.3: computable Definition of Done — 7 gates (G1 all tasks done, G2 zero stale claims, G3 zero unack conflicts, G4 doctor clean, G5 no proposed decisions, G6 STATE.md ≤ 60 lines, G7 no escalated tasks). Exit 0 only when all pass |
| `baton gate` | v1.3: CI health gate (doctor + stale + conflicts + task flow); exit 7 on fail; `--init` writes the workflow |
| `baton workers` | v1.3: worker reputation from report front matter + ledger outcomes (score = 10·accepted − 5·rejected − 1·verify_fails) |
| `baton mcp` | MCP server on stdio (read-only tools; see below) |
| `baton upgrade / migrate` | Reserved for v2 (exits 4) |

## MCP server

Any MCP client (Claude Desktop, Cursor, your own agent) can consume the project ledger:

```json
{
  "mcpServers": {
    "baton": { "command": "baton", "args": ["mcp"] }
  }
}
```

Tools: `list_tasks`, `get_task`, `get_packet`, `status`, `stale`, `conflicts`, `doctor`, `search_events`, plus v1.3: `search_files` (BM25 retrieval), `next_task` (scheduler), `project_done` (DoD gates), `list_workers` (reputation), `lease_take` / `lease_list` / `lease_release` (dispatch), `gate` (CI health).

Deliberately **read-only plus packet issuance** — `verify` executes untrusted worker code (guard G21) and stays on a human's terminal.

## Retrieval (v1.3)

Packets now carry a **retrieved-context tier**: BM25 over the repo (k1 = 1.5, b = 0.75) ranks files against the task title + touches and adds scored one-line snippets. Same security bar as packet file inclusion — `never_include` globs and per-file secret scans apply, files already present as `reads` are excluded, and `retrieval_snippets: 0` in `.baton/policy.yml` disables the tier. `baton search "query"` exposes the same engine on the CLI. Deterministic, no AI call, no network.

## Orchestrator core (v1.3)

The orchestrator is deterministic tooling around the same ledger — no AI in the loop for scheduling or termination:

- `baton next` — picks the oldest `ready` task whose dependencies are all `done` and whose `touches` don't overlap any in-flight (assigned / in_review / needs_work) task. Prints the queue and why the rest are blocked.
- `baton lease take <T-id> --worker <name> [--ttl 120]` — exclusive dispatch rights over a task's touch areas. Overlapping active lease => exit 5. Leases survive restarts (expiry is recomputed from ledger timestamps) and use the same static-prefix overlap semantics as decisions.
- `baton reject` twice on a task → an `escalated` event is appended automatically; escalated tasks are excluded from auto-dispatch until a human decides (`baton done` gate G7 reports them).
- `baton workers` — reputation derived from evidence: report front matter (`worker:`) joined with ledger outcomes.
- `baton done` — the computable Definition of Done. Seven gates, all mechanical:

  - **G1** every task ends `done` (rejected tasks pass only via a done follow-up)
  - **G2** zero stale verified claims
  - **G3** zero unacknowledged conflicts
  - **G4** `doctor` reports no errors
  - **G5** no decisions left `proposed`
  - **G6** `STATE.md` present and <= 60 lines
  - **G7** no escalated tasks awaiting human review

  `baton done` exits 0 only when all gates pass. This is the signal an orchestrator (human or machine) should act on — not a vibes check.
- `baton gate` — CI-facing health gate (doctor + stale dry-run + conflicts + task flow). `baton gate --init` writes `.github/workflows/baton-gate.yml` so the repo self-instruments its own CI.

## Locked tests (v1.3.1)

`diff_scope` stops edits outside the allowed files — but when test files are *inside* scope, a worker could rewrite the very tests it is judged by. Verify closes that hole:

- `protected_paths` in `.baton/policy.yml` (default: `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`) lists the files workers are judged by.
- If a worker modifies a protected file and the task does not set `allow_protected`, verify **restores the merge-base versions into the worktree before running any check** — so cmd/grep/file_exists checks always judge the locked tests, never the worker's edits — and adds a failing `protected_paths` row to the verdict.
- A task that legitimately changes tests says so up front: `baton task new "..." --allow-protected`. Verify then judges with the worker's versions and shows a passing `protected_paths` row with a note. The flag lives in the task front matter, inside the lock hash.

## Merging diverged branches (v1.3.1)

Worker branches append ledger events, and `project-memory/ledger.jsonl` carries `merge=union` in `.gitattributes` so merges auto-resolve. Two branches allocating from the same base produce duplicate event IDs after the merge — that is expected, detected, and repaired, never silent:

```bash
git merge worker-a --no-edit
baton doctor        # exit 3: E_DUPLICATE_EVENT_ID / E_NON_INCREASING_ID
baton doctor --fix  # renumber events, remap colliding claim/run IDs,
                    # append a ledger_repaired audit event
baton doctor        # clean; ID allocation continues from the repaired tail
```

`--fix` refuses to run when the ledger has malformed (unparseable) lines — repair never guesses.

## Stage history

| Version | Stage | Contents |
|---|---|---|
| 1.0.x | 0 | manual trial run (T-0001 accepted; T-0002 rejected for scope creep; T-0003 rejected: worker claimed 6/6 tests, verify showed 2/6) |
| 1.1.x | 1–2 | packets + verify with the 14 P0 fixes |
| 1.2.0 | 3–4 | staleness, conflicts, status/log/doctor, worktree orphan GC |
| 1.3.0 | 5 | **MCP server, CI gate (`baton gate`), BM25 retrieval tier, `baton search`, area leases, scheduler (`baton next`), reputation (`baton workers`), escalation, computable DoD (`baton done`)** |
| 1.3.1 | tighten | no new features: union-merge repair (`doctor --fix`), locked tests (`protected_paths` + `--allow-protected`), one name (`baton`), portable tests |
| next | 6+ | deterministic dispatch loop on top of leases; DAG ordering; merge queue |

## GitHub Action

`.github/workflows/verify.yml` (this repo) is a working example. In another repo:

```yaml
- uses: isaJrKai/baton@v1
  with:
    task-id: T-0001
    baton-source: github        # or npm once published
    baton-repo: isaJrKai/baton
```

It runs `baton doctor`, then `baton verify` for the task at the PR head, and appends a `baton:ci` Markdown summary to the step summary. A failing check fails the job — verified claims, not vibes, gate the PR.

## Security model

- All git access goes through one wrapper allowlisting read-only subcommands plus `worktree add --detach / remove / list`; `git config` is explicitly forbidden (G6/G7).
- Verification runs only in temporary detached worktrees under `.baton/tmp/`, never your working directory (G8). Orphaned worktrees from killed runs are cleaned by PID on startup.
- Workers are judged by the locked tests: `protected_paths` (test globs by default) are restored from the merge-base before checks run, and a worker's edit to them fails `protected_paths` unless the task was created with `--allow-protected`.
- Worker code execution is explicit: `cmd` checks require an allowlisted command and `--yes` acknowledgment (G21).
- Secrets are scanned from diffs with pattern masking; credential files (`**/.npmrc`, `**/.aws/credentials`, …) are excluded from packet inclusion by `never_include`.
- Packets separate the trusted header from untrusted context — injection through task text cannot alter the contract.

## Project memory layout

```
project-memory/
  STATE.md            # essence — regenerated region is marked baton:generated
  CONSTRAINTS.md      # hard rules every worker must respect
  decisions/          # D-XXXX.md — doctrine, one decision per area key
  tasks/              # T-XXXX.md — scope (touches), checks, objective
  reports/            # R-XXXX.md — worker closeout reports (claims)
  packets/            # compiled packets (gitignored)
  sessions/           # handoff sessions (gitignored)
  ledger.jsonl        # append-only event log (merge=union in .gitattributes)
```

## Documentation

- [Build Specification v1.1](docs/spec-v1.1.md) — revision-marked spec: 12 P0 changes, legacy ledger compatibility, stage impact, manual acceptance steps.
- [Build Specification v1.1.1 Addendum](docs/addendum-v1.1.1.md) — 14-item P0 list, salvage catalog (ADOPT/FIX/DISCARD) of a third-party partial implementation, rejected features.
- [Stage 0 Trial Report](docs/stage0-trial-report.md) — three real handoffs done by hand; two real defects caught by checks; gate questions answered honestly, limitations included.

## Development

```bash
npm ci
npm run typecheck
npm test              # typecheck + vitest (integration tests build real git repos)
npm run guard:network # G24: no network imports in src/
```

Status: Stage 1 (Packets), Stage 2 (Verify), Stage 3 (Freshness), Stage 4 (View), Stage 5 (Reach: MCP + GitHub Action) implemented; v1.3 adds the retrieval tier and the orchestrator core (scheduler, escalation, reputation, DoD gate); v1.3.1 hardens the merge story and locks the tests workers are judged by. Feature-frozen until the tool has 10 real handoffs behind it. Node >= 20.

## License

MIT — see [LICENSE](LICENSE).
