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
import { search } from '../commands/search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVER_VERSION = '1.2.0';
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
        callTool(name, args, repoRoot)
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
