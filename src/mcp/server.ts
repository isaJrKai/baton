// baton mcp — Stage 5 (Reach): Model Context Protocol server.
// Spec §5/§15: the MCP server consumes the same ledger, schemas, and CLI core.
// Transport: stdio, newline-delimited JSON-RPC 2.0 (per MCP spec). No SDK dependency.
//
// Tool surface is deliberately READ-ONLY plus packet issuance (the consume side of
// the workflow). Verify is NOT exposed: it executes untrusted worker code (G21)
// and must run under a human's terminal, not an agent connection.
// Every response is text content; errors are reported as isError text, never thrown.
import * as readline from 'node:readline';
import { packet } from '../commands/packet.js';
import { taskList, taskShow } from '../commands/task.js';
import { status, formatStatusOutput } from '../commands/status.js';
import { stale, formatStaleTable } from '../commands/stale.js';
import { conflicts, formatConflictsTable } from '../commands/conflicts.js';
import { doctor, formatDoctorOutput } from '../commands/doctor.js';
import { search, searchFiles } from '../commands/search.js';
import { next } from '../commands/next.js';
import { done } from '../commands/done.js';
import { workers } from '../commands/workers.js';
import { leaseTake, leaseRelease, leaseList } from '../commands/lease.js';
import { gate } from '../commands/gate.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVER_VERSION = '1.3.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, repoRoot: string) => Promise<string>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_tasks',
    description: 'List Baton tasks with their derived status. Optional filter by status (draft, ready, assigned, in_review, needs_work, blocked, done, rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'filter by task status' },
      },
    },
    handler: async (args, repoRoot) => {
      const tasks = await taskList(repoRoot, args.status as string | undefined);
      if (tasks.length === 0) return 'No tasks found.';
      return tasks.map(t => `${t.id}  ${t.status.padEnd(12)}  ${t.title}`).join('\n');
    },
  },
  {
    name: 'get_task',
    description: 'Read the full Markdown source of a task file (front matter + body) by ID, e.g. T-0001.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'task ID, e.g. T-0001' },
      },
      required: ['task_id'],
    },
    handler: async (args, repoRoot) => taskShow(repoRoot, String(args.task_id)),
  },
  {
    name: 'get_packet',
    description: 'Compile (issue) the work packet for a locked task — the exact context brief a worker model should receive. Writes the packet to project-memory/packets/ and records packet_issued in the ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'task ID, e.g. T-0001' },
        budget: { type: 'number', description: 'optional token budget override' },
      },
      required: ['task_id'],
    },
    handler: async (args, repoRoot) => {
      const result = await packet(repoRoot, String(args.task_id), {
        budget: typeof args.budget === 'number' ? args.budget : undefined,
      });
      if (!result.outputPath) {
        throw new Error('packet compiled but no output path was returned');
      }
      const text = await readFile(result.outputPath, 'utf8');
      const header = `# packet: ${result.outputPath}\n# tokens: ~${result.tokensUsed}/${result.budget}  sha256: ${result.packetSha}\n# omitted: ${result.omitted.length > 0 ? result.omitted.join(', ') : 'none'}\n\n`;
      return header + text;
    },
  },
  {
    name: 'status',
    description: 'Project status summary: task counts by status, stale claims, items needing attention, base commit.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const result = await status(repoRoot, {});
      return formatStatusOutput(result, true);
    },
  },
  {
    name: 'stale',
    description: 'Report verified claims whose anchor files changed since verification (dry-run: writes nothing to the ledger).',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const result = await stale(repoRoot, { dryRun: true });
      return formatStaleTable(result);
    },
  },
  {
    name: 'conflicts',
    description: 'List decision and claim conflicts (overlapping areas/touches, superseded decisions).',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const result = await conflicts(repoRoot, {});
      return formatConflictsTable(result);
    },
  },
  {
    name: 'doctor',
    description: 'Structural integrity report: unparseable files, duplicate IDs, ledger problems, hash mismatches, orphan reports, stale worktrees.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const result = await doctor(repoRoot);
      return formatDoctorOutput(result);
    },
  },
  {
    name: 'search_events',
    description: 'Search the ledger event log. Filters: task ID, event type; pagination via last/limit/offset. Returns JSON lines.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'filter by task ID' },
        type: { type: 'string', description: 'filter by event type' },
        last: { type: 'number', description: 'only the most recent N matches' },
        limit: { type: 'number', description: 'page size' },
        offset: { type: 'number', description: 'page offset' },
      },
    },
    handler: async (args, repoRoot) => {
      const { matches, total } = await search(repoRoot, {
        task: args.task as string | undefined,
        type: args.type as string | undefined,
        last: typeof args.last === 'number' ? args.last : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
      });
      const body = matches.map(e => JSON.stringify(e)).join('\n');
      return `total: ${total}\n${body}`;
    },
  },
  {
    name: 'search_files',
    description: 'BM25 keyword retrieval over repo files (never_include + secret-scan respected). Returns ranked paths with scores and one-line snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free-text query' },
        top: { type: 'number', description: 'max hits (default 8)' },
      },
      required: ['query'],
    },
    handler: async (args, repoRoot) => {
      const { hits } = await searchFiles(repoRoot, String(args.query), {
        top: typeof args.top === 'number' ? args.top : undefined,
      });
      if (hits.length === 0) return 'No files match the query.';
      return hits.map(h => `${h.score.toFixed(3)}  ${h.path}\n          ${h.snippet}`).join('\n');
    },
  },
  {
    name: 'next_task',
    description: 'Deterministic scheduler: the next eligible task (dependencies done, touches do not overlap any in-flight task). Returns pick + queue + blockers.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const r = await next(repoRoot);
      if (!r.pick) {
        const reasons = [
          r.inFlight.length > 0 ? `in flight: ${r.inFlight.map(f => f.id).join(', ')}` : '',
          r.blockedByDeps.length > 0 ? `waiting on deps: ${r.blockedByDeps.map(b => `${b.id}(needs ${b.unmet.join(',')})`).join(', ')}` : '',
          r.blockedByConflict.length > 0 ? `area conflicts: ${r.blockedByConflict.map(b => b.id).join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return reasons ? `No eligible task right now. ${reasons}` : 'No eligible task right now. No tasks are ready — run: baton task ready <T-id>';
      }
      return `NEXT: ${r.pick.id}  ${r.pick.title}\ntouches: ${r.pick.touches.join(', ')}\n\nIssue packet: baton packet ${r.pick.id}`;
    },
  },
  {
    name: 'project_done',
    description: 'Definition of Done check: reports whether all tasks are accepted, doctor is clean, and no claim conflicts remain. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const r = await done(repoRoot);
      if (r.done) return 'BATON: DONE. All gates passed.';
      const failed = r.gates.filter(g => !g.pass);
      return 'BATON: NOT DONE.\n' + failed.map(g => `FAIL ${g.id} ${g.label}: ${g.detail}`).join('\n');
    },
  },
  {
    name: 'list_workers',
    description: 'Worker reputation table derived from report front matter (worker:) joined with ledger outcomes (accepted/rejected/verify failures).',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, repoRoot) => {
      const { workers: list } = await workers(repoRoot);
      if (list.length === 0) return 'No worker reputation yet (no reports with worker: front matter).';
      return list.map(w => `${w.worker}: score ${w.score} (accepted ${w.accepted}, rejected ${w.rejected}, verify_fails ${w.verifyFailures})`).join('\n');
    },
  },
  {
    name: 'lease_take',
    description: 'Take an exclusive area lease for a task (T-xxxx) before starting work. Refused if an overlapping lease is active. Writes lease_acquired to the ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^T-\\d{4}$' },
        worker: { type: 'string', description: 'worker identity (agent name/id)' },
        ttl_minutes: { type: 'number', description: 'lease TTL in minutes (default 120)' },
        allow_branch: { type: 'boolean' },
      },
      required: ['task_id', 'worker'],
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const result = await leaseTake(repoRoot, String(args.task_id), {
        worker: String(args.worker),
        ttlMinutes: typeof args.ttl_minutes === 'number' ? Math.max(1, Math.floor(args.ttl_minutes)) : 120,
        allowBranch: args.allow_branch === true,
      });
      return JSON.stringify({ leased: true, ...result }, null, 2);
    },
  },
  {
    name: 'lease_list',
    description: 'List active (unexpired, unreleased) area leases. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, repoRoot) => {
      const leases = await leaseList(repoRoot);
      if (leases.length === 0) return 'No active leases.';
      return JSON.stringify(leases, null, 2);
    },
  },
  {
    name: 'lease_release',
    description: 'Release the area lease on a task (T-xxxx). Writes lease_released to the ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^T-\\d{4}$' },
        reason: { type: 'string' },
        allow_branch: { type: 'boolean' },
      },
      required: ['task_id', 'reason'],
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const result = await leaseRelease(repoRoot, String(args.task_id), {
        reason: String(args.reason),
        allowBranch: args.allow_branch === true,
      });
      return JSON.stringify({ released: true, ...result }, null, 2);
    },
  },
  {
    name: 'gate',
    description: 'CI health gate (read-only): doctor + stale dry-run + unacknowledged conflicts + task flow. Returns pass/fail per check.',
    inputSchema: {
      type: 'object',
      properties: {
        strict_done: { type: 'boolean', description: 'also require all baton done gates to pass' },
      },
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const result = await gate(repoRoot, { strictDone: args.strict_done === true });
      return result.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n') + (result.pass ? '\nGATE: PASS' : '\nGATE: FAIL');
    },
  },
];

function toolListResult() {
  return {
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>, repoRoot: string) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    const text = await tool.handler(args ?? {}, repoRoot);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const e = err as Error & { exitCode?: number };
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
  }
}

function writeMessage(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export async function runMcpServer(repoRoot: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let toolQueue: Promise<void> = Promise.resolve();

  // Wait for in-flight tool calls before exiting when stdin closes.
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };

  rl.on('line', line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const id = req.id ?? null;
    const isNotification = req.id === undefined || req.id === null;

    switch (req.method) {
      case 'initialize':
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'baton', version: SERVER_VERSION },
          },
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        // notifications: no response
        return;
      case 'ping':
        writeMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        writeMessage({ jsonrpc: '2.0', id, result: toolListResult() });
        return;
      case 'tools/call': {
        const params = req.params ?? {};
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        pending++;
        // Serialize tool calls: several tools write the ledger (lease_take,
        // packet issuance) — concurrent execution would race on the ledger.
        toolQueue = toolQueue
          .then(() => callTool(name, args, repoRoot))
          .then(result => writeMessage({ jsonrpc: '2.0', id, result }))
          .catch(err => writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `internal error: ${(err as Error).message}` },
          }))
          .finally(() => {
            pending--;
            maybeExit();
          });
        return;
      }
      default:
        if (!isNotification) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${req.method}` },
          });
        }
        return;
    }
  });

  rl.on('close', () => {
    closed = true;
    maybeExit();
  });

  // Keep the process alive until stdin closes.
  await new Promise<void>(() => { /* resolved by rl 'close' */ });
}
