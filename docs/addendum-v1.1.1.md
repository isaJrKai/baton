<!-- Converted from Baton_Build_Specification_v1.1.1_Addendum.docx (30 September 2026). -->
<!-- Addendum: salvaged reference implementations plus two promoted P0 changes (P0-13, P0-14). -->

# BATON — Build Specification v1.1.1 — Addendum

*Salvaged reference implementations + two promoted P0 changes (P0-13, P0-14)*

Companion to Baton Build Specification v1.1 (30 September 2026)

v1.1.1 · 30 September 2026

**Status: P0 list now contains 14 changes. P1/P2 unchanged from v1.1.**

Where this document and v1.1 disagree, this document wins for the listed changes only. All other v1.1 rules remain in force.

## 0. What this addendum is

A third-party tarball ("Baton Genius Edition v1.1") was offered as a complete v1.1 implementation. Review showed it to be a partial scaffold: ~30% of the v1.1 P0 list implemented end-to-end, the rest stubs or missing. The tarball's marketing copy ("Memory 2.0", "4-layer instrument", replay cache, crystallize command) describes features that do not exist in the code.

**This addendum does three things:**

- Promotes two P1 fixes that the tarball already implements correctly into the P0 list as P0-13 and P0-14. These are now required for v1.1.1 conformance, not deferred to v1.2.
- Catalogs every salvageable file from the tarball as a reference implementation, with a verdict (ADOPT / FIX / DISCARD) and concrete fix-notes. The builder may use ADOPT and FIX files as starting points; DISCARD files must be rewritten from the v1.1 spec.
- Explicitly lists what was rejected and why, so the builder does not waste time searching for hallucinated features.

*Net effect on the build plan: the builder saves approximately 1–2 days of boilerplate (schemas, lock, ledger-file, git wrapper structure, secrets, packet tier skeleton). The builder still implements all 14 P0 changes end-to-end. The tarball is a head start, not a shortcut.*

## 1. New P0 changes (P0-13, P0-14)

Both are promotions from the deferred P1 list. Both are already correctly implemented in the tarball. Promoting them now because they cost nothing to adopt (the code exists) and address real v1.1 gaps (issue #1 mitigation, issue #20 security default).

### P0-13 · Promote strength classification from P1 (already implemented)

**Type:** ADDITIVE (promotion)

**Location:** New: §3.7 (Check strength). Existing: §6.4 verdict rendering, §5.4 task ready warning.

**Rationale:**

The reviewer's P1 fix list (issue #1 mitigation) called for a `baton task lint` warning based on check strength. The tarball's `src/core/verdicts.ts` already implements the classification: `cmd` (behavior) > `contract` (interface) > `grep`/`file_exists` (artifact) > `diff_scope`/`no_secrets` (hygiene). Promoting this from P1 to P0 because (a) it is already implemented, (b) it is the single most important mitigation for issue #1 (weak checks producing meaningless `verified` status), and (c) the strength value is a property of the check type, not the check itself — it costs nothing to compute and surfaces in `verify` output and `baton status`. This is the cheapest signal we can give the human that a task's `verified` claims rest on behavior checks, not artifact checks.

**v1.1 (old):**

```text
// (no entry in v1.1 for strength classification — deferred to P1)
```

**v1.1.1 (new):**

```ts
// §3.7 Check strength (new)
type Strength = 'behavior' | 'interface' | 'artifact' | 'hygiene';
function strengthOf(type: Check['type']): Strength {
  switch (type) {
    case 'cmd': return 'behavior';
    case 'contract': return 'interface';
    case 'grep':
    case 'file_exists': return 'artifact';
    case 'diff_scope':
    case 'no_secrets': return 'hygiene';
  }
}

// §5.4 task ready warning (broadened)
// Existing v1.0: warn if only diff_scope and no_secrets
// v1.1.1: warn if no check of strength 'behavior' or 'interface'
// (i.e., no cmd or contract check present)

// §6.4 verdict rendering
// verify table renders strength alongside check id:
//   tests (cmd · behavior) — pass
//   scope (diff_scope · hygiene) — pass
//   schema (grep · artifact) — pass

// §7.3 baton status
// Counts group by strength:
//   verified claims: 4 (3 behavior, 1 artifact)
//   Weak tasks: 1 (no behavior or interface check)
```

### P0-14 · Promote extended `never_include` defaults from P1 (already implemented)

**Type:** ADDITIVE (promotion)

**Location:** §3.3 Policy template + Appendix B (default secret patterns context)

**Rationale:**

Issue #20 in the reviewer's list flagged that v1.0's `never_include` defaults (`.env*`, `**/*.pem`, `**/*.key`, `**/id_*`, `**/secrets/**`) miss common credential files: `.npmrc`, `.pypirc`, `.netrc`, `.aws/credentials`. The tarball's `src/commands/init.ts` already includes the extended set. Promoting to P0 because (a) it is already implemented, (b) it is a one-line default change with zero behavior risk, and (c) leaving these out of the default is a security regression the spec should not carry into v1.2. Builders should adopt the extended list verbatim.

**v1.1 (old):**

```ts
// v1.1 §3.3 policy template
never_include: [".env*", "**/*.pem", "**/*.key", "**/id_*", "**/secrets/**"]
```

**v1.1.1 (new):**

```text
// v1.1.1 §3.3 policy template
never_include:
- ".env*"
- "**/.env.*"
- "**/*.pem"
- "**/*.key"
- "**/id_*"
- "**/secrets/**"
- "**/.npmrc" # npm credentials
- "**/.pypirc" # PyPI credentials
- "**/.netrc" # generic HTTP credentials
- "**/.aws/credentials" # AWS CLI credentials
- "**/.aws/config" # AWS CLI config (may contain profiles)

// Note: "**/.env.*" covers .env.production, .env.local, etc. that
// .env* alone misses on some filesystems due to glob edge cases.
// .aws/config is included because it can contain role assumptions
// and region hints that are sensitive in some deployments.
```

## 2. Salvaged reference implementations

Every file from the tarball's baton-cli/ tree, with a verdict and fix-notes. ADOPT files may be used as-is. FIX files have correct structure but specific bugs or missing pieces — patch in place. DISCARD files must be rewritten from the v1.1 spec.

| File | Verdict | Slots into | Fix needed |
|---|---|---|---|
| package.json | ADOPT | Tool root, Stage 1 | Pin to exact versions in production (currently ^); add `engines: { node: ">=20" }` |
| tsconfig.json | FIX | Tool root, Stage 1 | Add `noUncheckedIndexedAccess: true` (G40). Currently missing — the v1.0 spec requires it explicitly. |
| vitest.config.ts | ADOPT | Tool root, Stage 1 | — |
| eslint.config.js | FIX | Tool root, Stage 1 | Deny list is incomplete. Add: node:dgram, node:dns, node:tls, fetch(, child_process.exec (matches G24 + reviewer's note). |
| scripts/guard-network.js | ADOPT | Build test, Stage 1 | Extend deny list to match eslint (above). Add a CI hook that runs this on every PR. |
| src/core/schemas.ts | FIX | Stage 1 (Packets) | Add POSIX validation to Report.changed_files (no `..`, no `\`, no leading `/` or `./`). Add decision hash field reader for P0-3. Verify Check discriminated union is exhaustive over v1.1 §3.3. |
| src/core/globs.ts | ADOPT | Stage 1 (Packets), Stage 3 | — |
| src/core/tokens.ts | ADOPT | Stage 1 (Packets) | — |
| src/core/ids.ts | ADOPT | Stage 1 | Document that the caller must already hold .baton/lock (P0-8). |
| src/core/secrets.ts | ADOPT | Stage 1, Stage 2 | Better masking than v1.0 (first 4 + `****` + last 4). Add: validate extra_secret_patterns compiles at policy load (issue #7). |
| src/core/packet-compile.ts | FIX | Stage 1 (Packets) | Tier structure is correct. Need: exact trusted-header text from Appendix A7 (currently paraphrased); per-file 8k cap on T2 reads (currently slices to 8k but no marker); per-file secret scan before --include-files inclusion (issue #19); last-worker-on-area line (reviewer §14.2). |
| src/core/ledger-replay.ts | FIX | Stage 1, Stage 3 | Reads P0-2 prior_status correctly. Missing: P0-5 dedupe by key (claim), P0-6 dedupe by run_id (claim_status), P0-4 base_commit comparison, P0-11 follow_up_task walk for rejected events. |
| src/core/verdicts.ts | ADOPT | Stage 2 (Verify), P0-13 | Strength classification promoted to P0-13. Verdict function correct. |
| src/core/staleness.ts | FIX | Stage 3 (Freshness) | Blob comparison approach is correct. Need: expand task.touches globs against git ls-tree to get concrete file set (currently compares glob strings). |
| src/core/conflicts.ts | ADOPT | Stage 3 (Freshness) | Both decision and claim conflicts correct. |
| src/io/lock.ts | ADOPT | Stage 1, Stage 2 | O_EXCL + backoff. Implements P0-8 acquisition correctly. |
| src/io/ledger-file.ts | ADOPT | Stage 1, Stage 2 | Lock held across write+fsync. Correct P0-8 implementation. |
| src/io/fs-safe.ts | ADOPT | Stage 1+ | realpath + prefix check. Correct G10 implementation. |
| src/io/git.ts | FIX | Stage 2 (Verify), P0-10 | Allowlist approach correct. Need: explicitly forbid `config` (P0-10 G7), allow `rev-parse --verify` and `worktree list` (P0-10 G6), reject branch names not matching `^[A-Za-z0-9._/-]+$`. |
| src/io/run-process.ts | FIX | Stage 2 (Verify) | BUG: spawn(cmd, {shell:false}) passes the entire cmd string as the executable name. Node looks for a binary literally named "npm test -- tasks" and fails. Fix: accept `string[]` argv, spawn(argv[0], argv.slice(1), opts). |
| src/templates/index.ts | FIX | Stage 0, Stage 1 | Templates are incomplete. Need full Appendix A1-A8: STATE.md (full), CONSTRAINTS.md (full), decision file, task file, report file, pointer block, packet skeleton (exact text), handoff log. |
| src/commands/init.ts | FIX | Stage 1 | Missing: pointer block to AGENTS.md/CLAUDE.md (spec §5.4), .gitignore/.gitattributes lines, git repo validation (exit 7 if not in repo), --rules-file flag (reviewer §14.7), --force flag for non-empty repos, first-run next-steps message. |
| src/cli.ts | DISCARD | — | All stubs. Builder rewrites from v1.1 spec §5.4, §6.3, §7.3 command list. |
| test/fixtures/sample-task.md | ADOPT | Stage 0, Stage 1 fixture | Good example task with description fields filled in. Use as golden test fixture. |

**Verdict legend:**

- ADOPT — correct against v1.1.1. Use as-is. May still benefit from minor polish but no functional change required.
- FIX — structure is correct but specific bugs or missing pieces must be patched. Fix notes column lists what.
- DISCARD — stubs, hallucinated features, or fundamentally wrong. Builder rewrites from v1.1 spec.

### 2.1 Most valuable salvages

**If the builder has time to adopt only a few files, these are the ones that save the most work:**

- **src/core/globs.ts** — staticPrefix + overlaps are non-trivial to get right (spec §3.5 is subtle). The tarball's implementation is correct.
- **src/core/secrets.ts** — better masking than v1.0 (first 4 + `****` + last 4 vs first 4 + ellipsis).
- **src/io/lock.ts + src/io/ledger-file.ts** — correct P0-8 implementation (O_EXCL + hold across write+fsync). Subtle to get right from scratch.
- **src/core/verdicts.ts** — strength classification already implemented; powers P0-13.
- **scripts/guard-network.js** — concrete G24 build test. Add to CI.

### 2.2 Files that need the most fixing

**These have correct structure but substantial gaps. Budget real implementation time for each:**

- src/commands/init.ts — missing pointer block, gitignore/gitattributes, git repo validation, --rules-file flag. Approximately 60% of the spec §5.4 contract is missing.
- src/core/packet-compile.ts — tier structure correct, but trusted-header text is paraphrased rather than verbatim from Appendix A7, and several reviewer suggestions (last-worker-on-area, per-file scan before --include-files) are not implemented.
- src/core/ledger-replay.ts — reads P0-2 correctly but misses P0-5, P0-6, P0-4, P0-11. The replay logic needs all four to satisfy v1.1.1.
- src/io/run-process.ts — has a real bug (passes cmd string as executable with shell:false). Must be fixed before any cmd check can run.
- src/templates/index.ts — templates are skeletons. Need full Appendix A1-A8 verbatim.

## 3. What was rejected — and why

The tarball's marketing copy describes features that do not exist in the code. The builder must not search for or attempt to integrate these. They are listed here so the builder can recognize them on sight and skip them.

### Stubbed CLI commands (verify, status, doctor, log, stale, packet, task)

console.log placeholders, not implementations. Builder rewrites from spec.

### Marketing copy: "Genius Edition", "Memory 2.0", "4-layer instrument"

Not in the spec. Branded language for features that don't exist. Discard entirely.

### "Surfaces / Trust Boundary / Pure Core CQRS / IO Edge / Repo-as-DB" framing

CQRS is inaccurate (Baton has no command/query separation beyond pure-core/io-edge). The other terms are speculative architecture, not implemented structure.

### "status 800ms → 12ms at 20k events" replay cache claim

No replay cache exists in the code. .baton/cache/replay.json is not created or read anywhere.

### baton crystallize command

Not in v1.0 or v1.1 spec. Hallucinated feature. If crystallization (distilling verified claims into essence) becomes valuable, specify it as Stage 6 — but only after the §15 trial proves the core loop works.

### MAP.md auto-generated map of tasks/decisions to globs

Not in spec. Could be a Stage 4 (--html) feature later, but do not implement now.

### "Memory 2.0 / 4 layers (Essence / Doctrine / Evidence / Provenance)"

Not in spec. The v1.1 memory model is already 4 layers in a different sense: STATE.md (essence), DECISIONS.md (doctrine), claims+ledger (evidence), git history (provenance). Reusing the names for a different structure would confuse the builder.

*If a future Baton version genuinely needs any of these features (e.g., a replay cache when ledger exceeds 50k lines, or a `crystallize` command after the §15 trial proves the core loop), they will be specified as a new Stage in v1.2 or later. Until then, they are out of scope.*

## 4. Updated impact on each stage

**Compared to v1.1, v1.1.1 adds P0-13 and P0-14, and gives the builder a reference scaffold to start from. Stage-by-stage:**

### Stage 0 (Templates)

- No P0 changes apply. Use tarball's test/fixtures/sample-task.md as a golden fixture.
- Adopt src/templates/index.ts only after FIX notes addressed (full Appendix A1-A8).

### Stage 1 (Packets)

- P0-1 (Check.description): ADOPT schemas.ts after FIX (changed_files validation added).
- P0-8 (lock + fsync): ADOPT src/io/lock.ts and src/io/ledger-file.ts as-is. Correct implementation.
- P0-12 (upgrade/migrate reserved): Builder adds to cli.ts.
- P0-13 (strength classification, new): ADOPT src/core/verdicts.ts. Wire strength into task ready warning (broaden from "only diff_scope and no_secrets" to "no behavior or interface check").
- P0-14 (extended never_include, new): ADOPT from tarball's init.ts default policy. Update Appendix B context in spec.
- Adopt src/core/packet-compile.ts after FIX notes (verbatim trusted header, per-file scan, last-worker line).
- Adopt src/core/globs.ts, src/core/tokens.ts, src/core/ids.ts, src/core/secrets.ts as-is.
- Adopt scripts/guard-network.js after extending deny list.

### Stage 2 (Verify)

- P0-7 (report_matches = fail, not skip): Builder implements in core/verdicts.ts.
- P0-9 (worktree path with pid): Builder implements in io/git.ts.
- P0-10 (git allowlist + denylist): FIX src/io/git.ts. Add config to denylist, allow rev-parse --verify and worktree list.
- P0-13 (strength in verify output): Wire strengthOf() into verdict table rendering.
- FIX src/io/run-process.ts before any cmd check can run.
- Update security tests: (a) worker edits its own task file → verify still reads base branch; (b) worker attempts git config core.hooksPath → blocked by G7.

### Stage 3 (Freshness)

- P0-2 (prior_status): ADOPT ledger-replay.ts reads it correctly. Builder adds the block/unblock commands that emit it.
- P0-3 (decision_status.hash): Builder adds hash tracking on decide accept.
- P0-4 (verify_run.base_commit): Builder emits it in verify command.
- P0-5 (claim dedupe by key): Builder adds dedupe to ledger-file.ts.
- P0-6 (claim_status dedupe by run_id): Builder adds dedupe to ledger-file.ts.
- P0-11 (rejected.follow_up_task): Builder adds to reject command.
- FIX src/core/staleness.ts: expand task.touches globs against git ls-tree to get concrete file set.
- ADOPT src/core/conflicts.ts as-is.

### Stage 4 (View)

- P0-1 (description in verify table): Render description alongside id.
- P0-13 (strength in status): Counts group by strength.
- P0-11 (follow_up_task in log): Render as forward edge in baton log --task.

### Stage 5 (Reach)

- No direct impact from P0-13 or P0-14. GitHub Action and MCP server consume the same ledger, schemas, and CLI.

## 5. Manual acceptance for v1.1.1 additions

**Only the two new P0 changes (P0-13, P0-14) need new acceptance steps. The 12 P0 changes from v1.1 keep their existing acceptance steps.**

### P0-13 (strength classification)

- Create a task with checks `[{id: scope, type: diff_scope, ...}, {id: secrets, type: no_secrets}]`.
- Run `baton task ready T-0001`. Confirm warning: "no behavior or interface check present — claims will not be verifiable beyond hygiene."
- Add a `cmd` check (e.g., {id: tests, type: cmd, run: "npm test"}). Re-run `baton task ready T-0001`. Confirm no warning.
- Run `baton verify T-0001` (with the cmd check passing). Confirm verdict table renders `tests (cmd · behavior) — pass`, not bare `tests — pass`.
- Run `baton status`. Confirm the verified-claims count is grouped: "verified claims: 2 (1 behavior, 1 artifact)" rather than a flat count.

### P0-14 (extended never_include)

- Run `baton init` in a fresh repo. Open .baton/policy.yml.
- Confirm `never_include` contains all 11 entries: `.env*`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_*`, `**/secrets/**`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/.aws/credentials`, `**/.aws/config`.
- Create a file at .npmrc with content `//registry.npmjs.org/:_authToken=abc123`.
- Create a task with `--include-files` that would include .npmrc.
- Run `baton packet T-0001 --include-files`. Confirm .npmrc is omitted with `Omitted: .npmrc (never_include)` in the packet footer.
- Run `baton verify T-0001` with a `no_secrets` check. Confirm the secret scan catches the same file if it appears in the diff (this is independent of never_include, which only governs packet inclusion).

*If either acceptance step does not produce the stated output, the P0 change is not done. The builder must report it as pending in the stage report with a clear blocker.*

### Salvage acceptance (optional, recommended)

**Before integrating any salvaged file, the builder should verify it passes its own unit tests. At minimum:**

- src/core/globs.ts: test staticPrefix and overlaps against spec §3.5 examples. Two globs overlap if one static prefix is a segment-wise prefix of the other; an empty prefix overlaps everything.
- src/core/secrets.ts: test against Appendix B patterns. Confirm masking produces first 4 + `****` + last 4.
- src/io/lock.ts + src/io/ledger-file.ts: test concurrent writers (two processes appending simultaneously) produce no interleaved or truncated lines.
- scripts/guard-network.js: test that adding `import { fetch } from 'node:https'` to any src/ file fails the guard.
- src/io/run-process.ts (after FIX): test that `run(['npm', 'test'], cwd)` executes `npm test`, not a binary named "npm,test".

## 6. Updated P0 list (v1.1.1)

The complete P0 list for v1.1.1 conformance. Fourteen changes. The builder must apply all fourteen before any stage is considered done.

| ID | Change | Type |
|---|---|---|
| P0-1 | Add `description` field to Check schema | ADDITIVE |
| P0-2 | Add `prior_status` to `blocked` ledger event | BREAKING |
| P0-3 | Add `hash` to `decision_status` ledger event | BREAKING |
| P0-4 | Add `base_commit` to `verify_run` ledger event | BREAKING |
| P0-5 | Fix `claim` dedupe key (task + statement + key) | BREAKING |
| P0-6 | Fix `claim_status` dedupe key (use run_id, not reason) | BREAKING |
| P0-7 | `report_matches`: missing report is `fail`, not `skip` | BREAKING |
| P0-8 | Lock held for entire ledger write transaction + fsync | BREAKING |
| P0-9 | Worktree path includes task ID and PID | BREAKING |
| P0-10 | Allow `git worktree list` and `git rev-parse --verify`; forbid `git config` | BREAKING |
| P0-11 | Add `follow_up_task?: string` to `rejected` ledger event | BREAKING |
| P0-12 | `baton upgrade` and `baton migrate` reserved (exit 4) | ADDITIVE |
| P0-13 | Promote strength classification from P1 (already implemented) | ADDITIVE (promotion) |
| P0-14 | Promote extended `never_include` defaults from P1 (already implemented) | ADDITIVE (promotion) |

*Two new entries (P0-13, P0-14) are promotions from the deferred P1 list. The original twelve (P0-1 through P0-12) are unchanged from v1.1.*

## 7. Builder brief — what to do with this addendum

**Read in this order:**

- v1.0 Baton Build Specification (full).
- v1.1 Revision document (full, 12 P0 changes).
- This v1.1.1 addendum (2 new P0 changes + salvage catalog).
- Then: extract the tarball, read each salvaged file against §2 of this addendum, decide which to adopt and which to fix.

**Rules of engagement:**

- Every P0 change in §6 of this addendum (the full 14-item list) is required. No exceptions, no deferrals.
- Salvaged files marked ADOPT may be used as-is. Mark them in the stage report as "adopted from reference implementation."
- Salvaged files marked FIX must be patched per the fix-notes column before use. Mark them as "adopted with fixes: \<list\>".
- Salvaged files marked DISCARD must be rewritten from the v1.1 spec. Do not look at the tarball's version.
- Anything in §3 (rejected) does not exist. Do not search for it. Do not implement it. If a future spec adds it, that spec will describe it concretely.
- Stage reports from v1.1.1 onward must list each of the 14 P0 changes as applied or pending, plus a salvage log: which files were adopted as-is, which were adopted with fixes, which were discarded.

*If anything in this addendum contradicts v1.1, this addendum wins for the listed changes only (P0-13, P0-14, the salvage catalog). All other v1.1 rules remain in force.*

*Owners: the salvage catalog is a starting point, not a contract. If a salvaged file turns out to have a bug not noted in the fix column, treat it as a FIX file with an additional bug — patch it and note the new fix in the stage report. Do not discard a salvage just because it has one more bug than expected.*
