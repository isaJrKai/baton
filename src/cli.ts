#!/usr/bin/env node
// Baton CLI entry point. Spec §9 CLI reference.
// v1.1.1: 14 P0 changes applied.

import { Command } from 'commander';
import { init } from './commands/init.js';
import { decideNew, decideAccept, decideReject } from './commands/decide.js';
import { taskNew, taskReady, taskList, taskShow, taskLint, taskBlock, taskUnblock, taskUnlock } from './commands/task.js';
import { packet } from './commands/packet.js';
import { reportCheck } from './commands/report-check.js';
import { verify, formatVerdictTable } from './commands/verify.js';
import { accept, reject } from './commands/accept-reject.js';
import { cleanupStaleWorktrees } from './io/git.js';
import { stale, formatStaleTable } from './commands/stale.js';
import { conflicts, formatConflictsTable } from './commands/conflicts.js';
import { status, formatStatusOutput, formatCiSummary } from './commands/status.js';
import { doctor, formatDoctorOutput } from './commands/doctor.js';
import { logCommand } from './commands/log.js';
import { statusHtml } from './commands/status-html.js';
import { search, formatSearchResults, searchFiles, formatFileResults } from './commands/search.js';
import { next, formatNextOutput } from './commands/next.js';
import { done, formatDoneOutput } from './commands/done.js';
import { workers, formatWorkersOutput } from './commands/workers.js';
import { leaseTake, leaseRelease, leaseList, formatLeaseTable } from './commands/lease.js';
import { gate, formatGateOutput, gateInit } from './commands/gate.js';
import { runMcpServer } from './mcp/server.js';

const program = new Command();
program
  .name('baton')
  .description('Baton — repo-native continuity and verification kit for AI-assisted development')
  .version('1.3.0');

// v1.2 G8: on startup, clean up stale .baton/tmp/wt-* worktrees from killed verify runs.
// NEVER touches sibling ../wt-* worker worktrees (G45).
program.hook('preAction', async () => {
  try {
    await cleanupStaleWorktrees(process.cwd());
  } catch {
    // Best-effort cleanup — don't block the command
  }
});

// baton init
program
  .command('init')
  .description('scaffold project-memory/, .baton/policy.yml, pointer blocks, gitignore')
  .option('--rules-file <path>', 'also write the pointer block to a rules file (e.g. .cursorrules, .github/copilot-instructions.md)')
  .action(async (opts: { rulesFile?: string }) => {
    try {
      const result = await init(process.cwd(), { rulesFile: opts.rulesFile });
      console.log('Baton initialized.');
      console.log('Created:');
      for (const c of result.created) console.log(`  + ${c}`);
      if (result.skipped.length > 0) {
        console.log('Skipped (already exist):');
        for (const s of result.skipped) console.log(`  - ${s}`);
      }
      console.log('Pointer blocks:');
      for (const p of result.pointers) console.log(`  ${p.file}: ${p.action}`);
      if (result.firstRun) {
        console.log('\nNext steps:');
        console.log('  baton decide "My first decision" --key area.thing --areas "src/**"');
        console.log('  baton decide accept D-0001');
        console.log('  baton task new "My first task" --touches "src/**"');
        console.log('  git add project-memory/tasks/T-0001.md && git commit -m "task T-0001"');
        console.log('  baton task ready T-0001');
        console.log('  baton packet T-0001');
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR init: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton decide
const decide = program.command('decide');
decide
  .argument('<title>')
  .option('--key <key>', 'decision key (dotted: area.thing)')
  .option('--areas <globs>', 'comma-separated glob areas')
  .option('--decision <text>', 'decision body text')
  .option('--why <text>', 'why this decision was made')
  .option('--alternatives <text>', 'alternatives considered')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (title: string, opts: { key?: string; areas?: string; decision?: string; why?: string; alternatives?: string; allowBranch?: boolean }) => {
    if (!opts.key || !opts.areas) {
      console.error('ERROR decide: --key and --areas are required');
      process.exit(2);
    }
    try {
      const id = await decideNew(process.cwd(), {
        title,
        key: opts.key,
        areas: opts.areas.split(',').map(s => s.trim()).filter(Boolean),
        decision: opts.decision,
        why: opts.why,
        alternatives: opts.alternatives,
        allowBranch: opts.allowBranch,
      });
      console.log(`Created decision ${id} (proposed). Accept with: baton decide accept ${id}`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR decide: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

decide
  .command('accept <D-id>')
  .option('--supersedes <D-id>', 'mark another decision as superseded')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (dId: string, opts: { supersedes?: string; allowBranch?: boolean }) => {
    try {
      await decideAccept(process.cwd(), dId, opts);
      console.log(`Decision ${dId} accepted.`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR decide accept: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

decide
  .command('reject <D-id>')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (dId: string, opts: { allowBranch?: boolean }) => {
    try {
      await decideReject(process.cwd(), dId, opts);
      console.log(`Decision ${dId} rejected.`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR decide reject: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton task
const task = program.command('task');
task
  .command('new <title>')
  .option('--touches <globs>', 'comma-separated globs for allowed files')
  .option('--depends <t-ids>', 'comma-separated task IDs this depends on')
  .action(async (title: string, opts: { touches?: string; depends?: string }) => {
    if (!opts.touches) {
      console.error('ERROR task new: --touches is required');
      process.exit(2);
    }
    try {
      const id = await taskNew(process.cwd(), {
        title,
        touches: opts.touches.split(',').map(s => s.trim()).filter(Boolean),
        depends: opts.depends ? opts.depends.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      });
      console.log(`Created task ${id} (draft). Edit the file, commit on main, then run: baton task ready ${id}`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task new: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('ready <T-id>')
  .option('--allow-branch', 'allow running on non-base branch')
  .option('--allow-weak <reason>', 'override no-behavior-check block with a reason (v1.2 §5.4)')
  .option('--add-allowlist', 'auto-add missing cmd checks to policy.yml allowed_commands')
  .action(async (tId: string, opts: { allowBranch?: boolean; allowWeak?: string; addAllowlist?: boolean }) => {
    try {
      const result = await taskReady(process.cwd(), tId, 'main', { allowBranch: opts.allowBranch, allowWeak: opts.allowWeak, addAllowlist: opts.addAllowlist });
      console.log(`Task ${result.taskId} locked.`);
      console.log(`  hash: ${result.hash.slice(0, 16)}...`);
      console.log(`  base: ${result.baseCommit.slice(0, 12)}`);
      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const w of result.warnings) console.log(`  ! ${w}`);
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task ready: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('list')
  .option('--status <status>', 'filter by status')
  .action(async (opts: { status?: string }) => {
    try {
      const tasks = await taskList(process.cwd(), opts.status);
      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }
      for (const t of tasks) {
        console.log(`${t.id}  ${t.status.padEnd(12)}  ${t.title}`);
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task list: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('show <T-id>')
  .action(async (tId: string) => {
    try {
      const text = await taskShow(process.cwd(), tId);
      console.log(text);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task show: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('lint <T-id>')
  .description('check task check strength (P0-13)')
  .action(async (tId: string) => {
    try {
      const result = await taskLint(process.cwd(), tId);
      console.log(`Task ${result.taskId}:`);
      console.log('Checks:');
      for (const c of result.checks) {
        console.log(`  ${c.id.padEnd(20)} ${c.type.padEnd(15)} ${c.strength}`);
      }
      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const w of result.warnings) console.log(`  ! ${w}`);
      } else {
        console.log('No warnings.');
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task lint: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton packet
program
  .command('packet <T-id>')
  .option('--budget <n>', 'token budget', parseInt)
  .option('--include-files', 'include file contents (T7)')
  .option('--out <path>', 'output file path')
  .option('--allow-branch', 'allow running on non-base branch (ledger writes still happen)')
  .action(async (tId: string, opts: { budget?: number; includeFiles?: boolean; out?: string; allowBranch?: boolean }) => {
    try {
      const result = await packet(process.cwd(), tId, {
        budget: opts.budget,
        includeFiles: opts.includeFiles,
        out: opts.out,
        allowBranch: opts.allowBranch,
      });
      console.log(`Packet for ${tId} written to ${result.outputPath}`);
      console.log(`  tokens: ~${result.tokensUsed} / ${result.budget}`);
      console.log(`  sha256: ${result.packetSha.slice(0, 16)}...`);
      console.log(`  omitted: ${result.omitted.length > 0 ? result.omitted.join(', ') : 'none'}`);
      // v1.2 G45: worker checkout is a sibling folder, never under .baton/tmp
      console.log(`\nWorker checkout (sibling folder, cut from committed base):`);
      console.log(`  git worktree add ../wt-${tId} -b baton/${tId}-<slug> main`);
      console.log(`  cd ../wt-${tId}`);
      // v1.2 fix #5: instructions for getting the report back to main
      console.log(`\nAfter the worker finishes and writes project-memory/reports/R-<n>.md:`);
      console.log(`  git add -A && git commit -m "worker output + report"`);
      console.log(`  cd <back to main repo>`);
      console.log(`  git checkout baton/${tId}-<slug> -- project-memory/reports/R-<n>.md`);
      console.log(`  baton report-check project-memory/reports/R-<n>.md`);
      console.log(`  baton verify ${tId} --head $(git rev-parse baton/${tId}-<slug>) --yes`);
      // Ledger commit reminder (G45)
      console.log(`\nLedger updated. Commit on main: git add project-memory/ledger.jsonl && git commit -m "packet ${tId} issued"`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR packet: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton report check
// v1.2 §5.4: --strict removed. report check always exits 6 on mismatch.
program
  .command('report-check <path>')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (reportPath: string, opts: { allowBranch?: boolean }) => {
    try {
      const result = await reportCheck(process.cwd(), reportPath, opts);
      console.log(`Report check: ${result.valid ? 'VALID' : 'INVALID'}`);
      console.log(`  sha: ${result.reportSha.slice(0, 16)}...`);
      console.log(`  claims added: ${result.claimsAdded}`);
      if (result.missingInReport.length > 0) {
        console.log(`  missing in report (${result.missingInReport.length}):`);
        for (const f of result.missingInReport.slice(0, 10)) console.log(`    + ${f}`);
      }
      if (result.extraInReport.length > 0) {
        console.log(`  extra in report (${result.extraInReport.length}):`);
        for (const f of result.extraInReport.slice(0, 10)) console.log(`    - ${f}`);
      }
      if (!result.headMatchesBranch) console.log('  head_commit not reachable in this repo');
      if (result.errors.length > 0) {
        console.log('Errors:');
        for (const e of result.errors) console.log(`  ! ${e}`);
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR report-check: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton task block/unblock/unlock (P0-2)
task
  .command('block <T-id>')
  .requiredOption('--reason <text>', 'reason for blocking')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { reason: string; allowBranch?: boolean }) => {
    try {
      const result = await taskBlock(process.cwd(), tId, opts.reason, { allowBranch: opts.allowBranch });
      console.log(`Task ${result.taskId} blocked (prior status: ${result.priorStatus}).`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task block: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('unblock <T-id>')
  .requiredOption('--reason <text>', 'reason for unblocking')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { reason: string; allowBranch?: boolean }) => {
    try {
      const result = await taskUnblock(process.cwd(), tId, opts.reason, { allowBranch: opts.allowBranch });
      console.log(`Task ${result.taskId} unblocked (restored to: ${result.restoredStatus}).`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task unblock: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

task
  .command('unlock <T-id>')
  .description('return to draft for re-ready (e.g., checks changed)')
  .requiredOption('--reason <text>', 'reason for unlocking')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { reason: string; allowBranch?: boolean }) => {
    try {
      const result = await taskUnlock(process.cwd(), tId, opts.reason, { allowBranch: opts.allowBranch });
      console.log(`Task ${result.taskId} unlocked. Edit the task file, commit, then run: baton task ready ${tId}`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR task unlock: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton verify (Stage 2)
program
  .command('verify <T-id>')
  .option('--branch <name>', 'worker branch name')
  .option('--head <sha>', 'head commit SHA')
  .option('--yes', 'acknowledge untrusted code execution (G21)')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { branch?: string; head?: string; yes?: boolean; allowBranch?: boolean }) => {
    try {
      const result = await verify(process.cwd(), tId, opts);
      console.log(formatVerdictTable(result));
      if (result.verdict === 'all_pass') process.exit(0);
      else process.exit(6);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR verify: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton accept
program
  .command('accept <T-id>')
  .option('--override <reason>', 'override from needs_work with a reason')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { override?: string; allowBranch?: boolean }) => {
    try {
      const result = await accept(process.cwd(), tId, opts);
      console.log(`Task ${result.taskId} accepted at commit ${result.commit.slice(0, 12)}.`);
      if (result.override) console.log(`  Override: ${result.override}`);
      console.log('Baton does not merge. Merge through your normal PR process.');
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR accept: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton reject
program
  .command('reject <T-id>')
  .requiredOption('--reason <text>', 'reason for rejection')
  .option('--follow-up <title>', 'create a follow-up task inheriting touches')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { reason: string; followUp?: string; allowBranch?: boolean }) => {
    try {
      const result = await reject(process.cwd(), tId, opts);
      console.log(`Task ${result.taskId} rejected: ${result.reason}`);
      if (result.rejections && result.rejections >= 2) {
        console.log(`ESCALATED: ${result.rejections} rejections on this task — human review required (orchestrator will not auto-dispatch it).`);
      }
      if (result.followUpTaskId) {
        console.log(`Follow-up task created: ${result.followUpTaskId}. Edit it, commit, then run: baton task ready ${result.followUpTaskId}`);
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR reject: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton stale (Stage 3)
program
  .command('stale')
  .description('check for stale verified claims')
  .option('--dry-run', 'do not write stale events to ledger')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (opts: { dryRun?: boolean; allowBranch?: boolean }) => {
    try {
      const result = await stale(process.cwd(), { dryRun: opts.dryRun, baseBranch: opts.allowBranch ? undefined : 'main' });
      console.log(formatStaleTable(result));
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR stale: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton conflicts (Stage 3)
program
  .command('conflicts')
  .description('list decision and claim conflicts')
  .option('--ack <key>', 'acknowledge a conflict')
  .option('--unack <key>', 'unacknowledge a conflict')
  .option('--note <text>', 'note for ack/unack')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (opts: { ack?: string; unack?: string; note?: string; allowBranch?: boolean }) => {
    try {
      const result = await conflicts(process.cwd(), opts);
      console.log(formatConflictsTable(result));
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR conflicts: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton status (Stage 3 + Stage 4)
program
  .command('status')
  .description('show project status summary')
  .option('--verbose', 'full lists')
  .option('--json', 'machine output')
  .option('--html', 'generate single-file HTML page (Stage 4)')
  .option('--events <n>', 'number of recent events in --html output (default 30)', parseInt)
  .option('--ci', 'CI summary: Markdown table between <!-- baton:ci --> markers')
  .option('--out <path>', 'output file path (default: .baton/status.html)')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (opts: { verbose?: boolean; json?: boolean; html?: boolean; events?: number; ci?: boolean; out?: string; allowBranch?: boolean }) => {
    try {
      if (opts.html) {
        const result = await statusHtml(process.cwd(), { out: opts.out, events: opts.events });
        console.log(`HTML status page written to ${result.outputPath}`);
        console.log(`  size: ${(result.sizeBytes / 1024).toFixed(1)} KB`);
      } else if (opts.ci) {
        const result = await status(process.cwd(), opts);
        console.log(formatCiSummary(result));
      } else {
        const result = await status(process.cwd(), opts);
        console.log(formatStatusOutput(result, opts.verbose));
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR status: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton doctor (Stage 3)
program
  .command('doctor')
  .description('check structural integrity')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (opts: { allowBranch?: boolean }) => {
    try {
      const result = await doctor(process.cwd());
      console.log(formatDoctorOutput(result));
      if (result.hasErrors) process.exit(3);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR doctor: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton log (Stage 3)
program
  .command('log')
  .description('print recent ledger events')
  .option('--last <n>', 'number of events to show', parseInt)
  .option('--task <T-id>', 'filter by task ID')
  .option('--type <event-type>', 'filter by event type')
  .option('--json', 'machine output')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (opts: { last?: number; task?: string; type?: string; json?: boolean; allowBranch?: boolean }) => {
    try {
      await logCommand(process.cwd(), opts);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR log: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton search — v1.3 dual mode:
//   baton search <query> → BM25 retrieval over repo files
//   baton search --task T-0001 [--type ...] → ledger event filter (P1, v1.2 §6)
program
  .command('search [query]')
  .description('search: free-text BM25 over repo files; with --task/--type filters the ledger instead')
  .option('--task <T-id>', 'filter ledger events by task ID')
  .option('--type <event-type>', 'filter ledger events by type (e.g. claim, verify_run, rejected)')
  .option('--last <n>', 'only the most recent N matches', parseInt)
  .option('--limit <n>', 'page size', parseInt)
  .option('--offset <n>', 'page offset', parseInt)
  .option('--top <n>', 'max retrieval hits (default 8)', parseInt)
  .option('--glob <globs>', 'restrict retrieval to comma-separated globs')
  .option('--json', 'machine output (JSON lines / JSON array)')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (query: string | undefined, opts: { task?: string; type?: string; last?: number; limit?: number; offset?: number; top?: number; glob?: string; json?: boolean; allowBranch?: boolean }) => {
    try {
      if (query && query.trim().length > 0) {
        const { hits } = await searchFiles(process.cwd(), query, {
          top: opts.top,
          globs: opts.glob ? opts.glob.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        });
        if (opts.json) {
          console.log(JSON.stringify(hits, null, 2));
        } else {
          console.log(formatFileResults(query, hits));
        }
      } else {
        const { matches, total } = await search(process.cwd(), opts);
        console.log(formatSearchResults(matches, total, opts.json));
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR search: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton mcp — Stage 5 (Reach): Model Context Protocol server (stdio, read-only tools)
program
  .command('mcp')
  .description('run the MCP server on stdio (read-only tools over the ledger)')
  .action(async () => {
    try {
      await runMcpServer(process.cwd());
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR mcp: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton next — v1.3 orchestrator core: deterministic scheduler
program
  .command('next')
  .description('pick the next eligible task (deps done, no area conflict with in-flight work)')
  .option('--json', 'machine output')
  .action(async (opts: { json?: boolean }) => {
    try {
      const result = await next(process.cwd());
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatNextOutput(result));
      }
      if (!result.pick) process.exit(1);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR next: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton done — v1.3 orchestrator core: Definition of Done calculator
program
  .command('done')
  .description('check the Definition of Done: all tasks accepted, doctor clean, no conflicts')
  .option('--json', 'machine output')
  .action(async (opts: { json?: boolean }) => {
    try {
      const result = await done(process.cwd());
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatDoneOutput(result));
      }
      if (!result.done) process.exit(1);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR done: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton workers — v1.3 orchestrator core: worker reputation from reports + ledger
program
  .command('workers')
  .description('worker reputation table (accepted/rejected/verify failures per worker)')
  .option('--json', 'machine output')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { workers: list } = await workers(process.cwd());
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
      } else {
        console.log(formatWorkersOutput(list));
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR workers: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton lease — v1.3 orchestrator: exclusive area leases with TTL
const lease = program.command('lease');
lease
  .command('take <T-id>')
  .requiredOption('--worker <name>', 'worker identity taking the lease')
  .option('--ttl <minutes>', 'lease TTL in minutes (default 120)', parseInt)
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { worker: string; ttl?: number; allowBranch?: boolean }) => {
    try {
      const result = await leaseTake(process.cwd(), tId, {
        worker: opts.worker,
        ttlMinutes: opts.ttl ?? 120,
        allowBranch: opts.allowBranch,
      });
      console.log(`Lease taken: ${result.taskId} by ${result.worker} until ${result.expiresAt}`);
      for (const a of result.areas) console.log(`  touches: ${a}`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR lease take: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

lease
  .command('release <T-id>')
  .requiredOption('--reason <text>', 'why the lease is being released')
  .option('--allow-branch', 'allow running on non-base branch')
  .action(async (tId: string, opts: { reason: string; allowBranch?: boolean }) => {
    try {
      await leaseRelease(process.cwd(), tId, { reason: opts.reason, allowBranch: opts.allowBranch });
      console.log(`Lease released: ${tId}`);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR lease release: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

lease
  .command('list')
  .description('show active (unexpired, unreleased) leases')
  .action(async () => {
    try {
      const leases = await leaseList(process.cwd());
      console.log(formatLeaseTable(leases));
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR lease list: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton gate — v1.3 CI health gate (Stage 5 Reach)
program
  .command('gate')
  .description('CI health gate: doctor + stale + conflicts + task flow (exit 7 on fail)')
  .option('--strict-done', 'also require baton done gates to pass')
  .option('--init', 'write .github/workflows/baton-gate.yml (never overwrites)')
  .option('--json', 'machine output')
  .action(async (opts: { strictDone?: boolean; init?: boolean; json?: boolean }) => {
    try {
      if (opts.init) {
        const result = await gateInit(process.cwd());
        console.log(result.created
          ? `Wrote ${result.path}. Baton now gates your CI.`
          : `${result.path} already exists — left untouched.`);
        return;
      }
      const result = await gate(process.cwd(), { strictDone: opts.strictDone });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatGateOutput(result));
      if (!result.pass) process.exit(7);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error(`ERROR gate: ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
  });

// baton upgrade — P0-12: reserved, exits 4
program
  .command('upgrade')
  .description('reserved for future v2 file format migration')
  .action(() => {
    console.error('migration not needed at v1; files carry baton_version: 1');
    process.exit(4);
  });

// baton migrate — P0-12: alias of upgrade
program
  .command('migrate')
  .description('alias of baton upgrade')
  .action(() => {
    console.error('migration not needed at v1; files carry baton_version: 1');
    process.exit(4);
  });

program.parse(process.argv);
