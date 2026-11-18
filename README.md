# Baton

**Repo-native continuity and verification kit for AI-assisted development.**

Baton lets a team of humans and AI agents work on the same repository without
losing the thread. It carries context forward between tasks, and it treats
every AI claim as unverified until a mechanical check says otherwise.

> Reports are claims. Checks decide truth.

## Why

AI coding agents have three recurring failure modes:

1. **Amnesia** — the next session doesn't know what the last one decided.
2. **Overclaiming** — "all tests pass" when they don't.
3. **Scope creep** — touching files the task never sanctioned.

Baton attacks all three with one mechanism: an append-only event ledger
(`project-memory/ledger.jsonl`) plus deterministic verification in a detached
git worktree. Nothing is trusted because a model said it.

## Install

```bash
npm install -g github:isaJrKai/baton#v1.3.0
baton --version   # 1.3.0
```

Requires Node 20+. No network access is ever performed by the CLI (enforced
by `scripts/guard-network.js` in CI).

## Quickstart

```bash
baton init
baton decide "Use SQLite for the ledger" --key storage.ledger --areas "project-memory/**"
baton decide accept D-0001
baton task new "Add retry helper" --touches "src/retry.ts"
# edit the task file, add checks, commit, then:
baton task ready T-0001
baton packet T-0001 --search
# give the packet to any AI worker on a branch...
baton report-check project-memory/reports/R-0001.md
baton verify T-0001 --branch baton/T-0001-retry --yes
baton accept T-0001
```

## The core loop

| Step | Command | What it guarantees |
|---|---|---|
| Decide | `baton decide` | decisions are versioned, keyed, and conflict-checked |
| Lock | `baton task ready` | task file is hash-locked; checks are graded by strength |
| Brief | `baton packet` | a 250–1100-token structured brief; T0–T7 tiered under a budget |
| Work | (your AI agent) | worker sees ONLY the packet: trusted header + untrusted regions |
| Claim | `baton report-check` | report schema, changed_files vs diff, head reachability |
| Verify | `baton verify` | runs checks in a detached worktree: tests, diff_scope, grep, no_secrets |
| Land | `baton accept` | ledger records the accepted commit; merge via your normal PR flow |

## Commands

### Core
- `baton init` — scaffold `project-memory/`, `.baton/policy.yml`, pointer blocks
- `baton decide [new|accept|reject]` — key decisions with `--key`, `--areas`
- `baton task new|ready|list|show|lint|block|unblock|unlock` — task lifecycle; `lint` grades check strength (P0-13)
- `baton packet <T-id> [--budget N] [--include-files] [--search]` — compile the work packet
- `baton report-check <path>` — validate a worker report against the diff
- `baton verify <T-id>` — mechanical verification in a detached worktree
- `baton accept|reject <T-id>` — terminal task states, recorded in the ledger

### Health (Stage 3/4)
- `baton stale` — verified claims whose watched files changed since their anchor
- `baton conflicts` — same-key accepted decisions; same-key divergent claims
- `baton status [--html]` — project summary, optional single-file HTML page
- `baton doctor` — structural integrity (ledger, hashes, orphans, worktrees)
- `baton log` — the append-only audit trail

### Reach (v1.3.0, Stage 5)
- `baton mcp` — **MCP stdio server**. Wire Baton into Claude Code, Cursor, or any MCP host:

  ```json
  {
    "mcpServers": {
      "baton": { "command": "baton", "args": ["mcp"] }
    }
  }
  ```

  Tools: `baton_status`, `baton_task_list`, `baton_task_show`, `baton_packet`,
  `baton_search`, `baton_doctor`, `baton_log`, `baton_lease_take`,
  `baton_lease_list`, `baton_lease_release`. Read-dominant by design: a worker
  can pull truth and claim areas, but never grade its own homework.

- `baton gate [--json]` — CI health gate (doctor + stale + conflicts + task flow). Exit 7 on failure.
- `baton gate --init` — writes `.github/workflows/baton-gate.yml`; never overwrites.

### Retrieval (v1.3.0)
- `baton search "query" [--top N]` — BM25 over the repo corpus. Deterministic, no AI, no network. `never_include` respected, snippets secret-masked.
- `baton packet --search` — adds the T5.5 *retrieved* tier to the packet: BM25-ranked snippets wrapped in `UNTRUSTED` markers, below verified claims, above raw commits.

### Orchestration primitives (v1.3.0)
- `baton lease take <T-id> --worker <name> [--ttl 120]` — exclusive dispatch rights over a task's touch areas. Overlapping active lease => exit 5. Recorded as `lease_acquired`/`lease_released` events; expiry recomputed by replay, so leases survive restarts.
- `baton lease list` / `baton lease release <T-id> --reason`
- `baton done` — the computable definition of complete. Six gates:

  - **G1** every task ends `done` (draft/ready/assigned/in_review/needs_work/blocked = fail)
  - **G2** zero stale verified claims
  - **G3** zero unacknowledged conflicts
  - **G4** `doctor` reports no errors
  - **G5** no decisions left `proposed`
  - **G6** `STATE.md` present and <= 60 lines

  `baton done` exits 0 only when all gates pass. This is the signal an
  orchestrator (human or machine) should act on — not a vibes check.

## Security model

- **Prompt-injection surface is explicit**: packet content is partitioned into a verbatim trusted header and `--- BEGIN/END UNTRUSTED ---` regions. Retrieval snippets are untrusted by construction.
- **Secrets never travel**: `never_include` globs (default: `.env*`, keys, `.aws/credentials`, ...) are excluded from packets and the search corpus; every packet is re-scanned before emission (P0-7); snippets are masked with the same pattern set.
- **Verification is isolated**: `verify` runs checks in a detached git worktree; task files are hash-locked; check commands are allowlisted in `policy.yml`; `git config` is forbidden in checks (hooksPath attack surface).
- **The ledger is append-only**: O_EXCL lock held across the whole write transaction, fsync before release (P0-8). IDs must be strictly increasing (`doctor` flags regressions).
- **No network**: the CLI never makes network calls; `scripts/guard-network.js` enforces this in CI (G24).

## Architecture notes

- **Ledger replay** is a pure function: tasks, claims, decisions, leases — all rebuilt from `ledger.jsonl`. `blocked`/`unblocked` carry `prior_status` (P0-2).
- **Packets are tiered** (T0 header, T1 constraints, T2 reads, T3 decisions, T4 conflicts, T5 verified claims, T5.5 retrieved, T6 commits, T7 files). Budget pressure drops the lowest tiers first and always says so in the `Omitted:` footer.
- **Leases use the same overlap semantics as decisions**: static-prefix glob overlap (`core/globs.ts`), so dispatch conflicts and decision conflicts can't disagree.
- **Reports and verification are separate muscles**: `report-check` validates the report's honesty (files touched, head reachable); `verify` validates the code's truth (checks run in a worktree). A worker lying in the report fails the first; broken code fails the second.

## Stage history

| Version | Stage | Contents |
|---|---|---|
| 1.0.x | 0 | manual trial run (T-0001 accepted; T-0002 rejected for scope creep; T-0003 rejected: worker claimed 6/6 tests, verify showed 2/6) |
| 1.1.x | 1–2 | packets + verify with the 14 P0 fixes |
| 1.2.0 | 3–4 | staleness, conflicts, status/log/doctor, worktree orphan GC |
| 1.3.0 | 5 | **MCP server, CI gate, BM25 retrieval tier, `baton search`, area leases, `baton done`** |
| next | 6+ | deterministic dispatch loop on top of leases; DAG ordering; worker reputation from ledger history |

## Development

```bash
npm install
npm test        # typecheck + 126 integration/unit tests
npm run build   # tsup -> dist/
npm run guard:network
```

Files carry `baton_version: 1`. `baton upgrade`/`migrate` are reserved (exit 4).

## License

MIT
