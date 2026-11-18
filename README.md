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
3. **Ledger** — every event (packet issued, claim made, check result, accept/reject) is an append-only line in `project-memory/ledger.jsonl`, replayable and hash-chained for audit.
4. **Memory** — `project-memory/` carries state (STATE.md), doctrine (DECISIONS.md), evidence (claims + ledger), and provenance (git history). Freshness decays: when anchor files change, verified claims go `stale`.

## Quickstart

```bash
npm install -g baton-cli        # or: npm install -g github:<owner>/baton-cli
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
| `baton task new\|ready\|list\|show\|lint\|block\|unblock\|unlock` | Task lifecycle; `ready` locks with hash; `lint` shows check strength |
| `baton packet <T-id>` | Compile the worker brief under a token budget |
| `baton report check <path>` | Validate a closeout report against the real diff |
| `baton verify <T-id>` | Run all checks in a detached worktree; verdict table with check strength |
| `baton accept / reject` | Close out a task; reject spawns follow-up tasks |
| `baton stale` | Claims whose anchor files changed since verification |
| `baton conflicts` | Decision and claim conflicts (`--ack` / `--unack`) |
| `baton status` | Summary; `--html` single-file page; `--ci` Markdown table for PR comments |
| `baton doctor` | Structural integrity: ledger, hashes, duplicates, orphan worktrees |
| `baton log / search` | Ledger history and filtered search (`--task`, `--type`, `--last`, `--limit`, `--offset`) |
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

Tools: `list_tasks`, `get_task`, `get_packet`, `status`, `stale`, `conflicts`, `doctor`, `search_events`.

Deliberately **read-only plus packet issuance** — `verify` executes untrusted worker code (guard G21) and stays on a human's terminal.

## GitHub Action

`.github/workflows/verify.yml` (this repo) is a working example. In another repo:

```yaml
- uses: <owner>/baton-cli@main
  with:
    task-id: T-0001
    baton-source: github        # or npm once published
    baton-repo: <owner>/baton-cli
```

It runs `baton doctor`, then `baton verify` for the task at the PR head, and appends a `baton:ci` Markdown summary to the step summary. A failing check fails the job — verified claims, not vibes, gate the PR.

## Security model

- All git access goes through one wrapper allowlisting read-only subcommands plus `worktree add --detach / remove / list`; `git config` is explicitly forbidden (G6/G7).
- Verification runs only in temporary detached worktrees under `.baton/tmp/`, never your working directory (G8). Orphaned worktrees from killed runs are cleaned by PID on startup.
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

Status: Stage 1 (Packets), Stage 2 (Verify), Stage 3 (Freshness), Stage 4 (View), Stage 5 (Reach: MCP + GitHub Action) implemented. Node >= 20.

## License

MIT — see [LICENSE](LICENSE).
