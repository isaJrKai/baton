// v1.3.0 — baton mcp: MCP (Model Context Protocol) stdio server. Stage 5 Reach.
//
// Exposes Baton to any MCP-capable AI host (Claude Code, Cursor, etc.).
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
//
// Tool surface is intentionally READ-DOMINANT: workers pull truth (status,
// tasks, packets, search, log, doctor) through the server. The only
// ledger-writing tools are packet (packet_issued, the normal producer event)
// and lease (dispatch scheduling). Verification stays in the CLI/CI where a
// human can see it — a worker must never grade its own homework.
//
// Safety: all paths resolved under cwd; no network; secrets masked in search
// results by core/search.ts.

import { createInterface } from 'node:readline';
import { status } from '../commands/status.js';
import { taskList, taskShow } from '../commands/task.js';
import { packet } from '../commands/packet.js';
import { doctor } from '../commands/doctor.js';
import { logCommand } from '../commands/log.js';
import { searchRepo } from '../core/search.js';
import { leaseTake, leaseList, leaseRelease } from '../commands/lease.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'baton-mcp';
const SERVER_VERSION = '1.3.0';

// ---------- tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, repoRoot: string) => Promise<string>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'baton_status',
    description: 'Project status summary: tasks by state, verified claims, staleness, conflicts. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, repoRoot) => {
      const result = await status(repoRoot, { verbose: false });
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: 'baton_task_list',
    description: 'List tasks with statuses. Optional status filter (draft|ready|assigned|in_review|needs_work|done|rejected|blocked).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'optional status filter' } },
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const tasks = await taskList(repoRoot, typeof args.status === 'string' ? args.status : undefined);
      return JSON.stringify(tasks, null, 2);
    },
  },
  {
    name: 'baton_task_show',
    description: 'Show a task file (T-xxxx) including objective, touches, checks.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', pattern: '^T-\\d{4}$' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => taskShow(repoRoot, String(args.task_id)),
  },
  {
    name: 'baton_packet',
    description: 'Compile the work packet for a task (T-xxxx). Writes packet_issued to the ledger. The packet is the ONLY thing a worker should consume.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^T-\\d{4}$' },
        budget: { type: 'number', description: 'token budget override' },
        allow_branch: { type: 'boolean', description: 'allow running off base branch' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const result = await packet(repoRoot, String(args.task_id), {
        budget: typeof args.budget === 'number' ? args.budget : undefined,
        allowBranch: args.allow_branch === true,
      });
      return result.text;
    },
  },
  {
    name: 'baton_search',
    description: 'BM25 search over the repo corpus (never_include respected, secrets masked). Use before asking for file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top: { type: 'number', description: 'max results (default 8)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      const { neverInclude, extra } = await loadSearchPolicy(repoRoot);
      const res = await searchRepo(repoRoot, String(args.query), {
        top: typeof args.top === 'number' ? args.top : undefined,
        neverInclude,
        extraSecretPatterns: extra,
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    name: 'baton_doctor',
    description: 'Structural integrity check: ledger, hashes, orphans. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, repoRoot) => {
      const result = await doctor(repoRoot);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: 'baton_log',
    description: 'Recent ledger events (append-only audit trail). Optional filters: last (count), task (T-id), type (event type).',
    inputSchema: {
      type: 'object',
      properties: {
        last: { type: 'number' },
        task: { type: 'string' },
        type: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (args, repoRoot) => {
      // logCommand prints to console; capture via redirect of console.log
      const orig = console.log;
      const buf: string[] = [];
      console.log = (...xs: unknown[]) => buf.push(xs.map(String).join(' '));
      try {
        await logCommand(repoRoot, {
          last: typeof args.last === 'number' ? args.last : undefined,
          task: typeof args.task === 'string' ? args.task : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          json: true,
        });
      } finally {
        console.log = orig;
      }
      return buf.join('\n') || '[]';
    },
  },
  {
    name: 'baton_lease_take',
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
    name: 'baton_lease_list',
    description: 'List active (unexpired, unreleased) area leases. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, repoRoot) => {
      const leases = await leaseList(repoRoot);
      return JSON.stringify(leases, null, 2);
    },
  },
  {
    name: 'baton_lease_release',
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
];

async function loadSearchPolicy(repoRoot: string): Promise<{
  neverInclude: string[];
  extra: { name: string; regex: string }[];
}> {
  try {
    const text = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policy = yaml.parse(text) as {
      never_include?: string[];
      extra_secret_patterns?: { name: string; regex: string }[];
    };
    return {
      neverInclude: policy.never_include ?? [],
      extra: policy.extra_secret_patterns ?? [],
    };
  } catch {
    return { neverInclude: [], extra: [] };
  }
}

// ---------- JSON-RPC plumbing ----------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function ok(id: number | string | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

function rpcError(id: number | string | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const text = await tool.handler(args ?? {}, repoRoot);
    return { content: [{ type: 'text', text }], isError: false };
  } catch (err) {
    const e = err as Error & { exitCode?: number };
    return {
      content: [{ type: 'text', text: `ERROR (exit ${e.exitCode ?? 1}): ${e.message}` }],
      isError: true,
    };
  }
}

export async function startMcpServer(repoRoot: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      process.stdout.write(rpcError(undefined, -32700, 'parse error'));
      continue;
    }

    // Notifications (no id) get no response.
    if (req.id === undefined) {
      continue;
    }

    try {
      if (req.method === 'initialize') {
        process.stdout.write(ok(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }));
      } else if (req.method === 'ping') {
        process.stdout.write(ok(req.id, {}));
      } else if (req.method === 'tools/list') {
        process.stdout.write(ok(req.id, {
          tools: TOOLS.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }));
      } else if (req.method === 'tools/call') {
        const name = String((req.params as { name?: string })?.name ?? '');
        const args = ((req.params as { arguments?: Record<string, unknown> })?.arguments) ?? {};
        const result = await dispatchTool(name, args, repoRoot);
        process.stdout.write(ok(req.id, result));
      } else {
        process.stdout.write(rpcError(req.id, -32601, `method not found: ${req.method}`));
      }
    } catch (err) {
      process.stdout.write(rpcError(req.id, -32603, `internal error: ${(err as Error).message}`));
    }
  }
}
