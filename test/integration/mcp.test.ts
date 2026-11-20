// Stage 5 (Reach): MCP server tests.
// Protocol: initialize → tools/list → tools/call over stdio newline-delimited JSON-RPC.
// Also verifies unknown methods return -32601 and in-flight calls complete before exit.
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

import { cliRunner, cliRunnerArgv } from '../helpers.js';
const CLI_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

interface McpResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: { serverInfo?: { name: string; version: string }; protocolVersion?: string; tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'baton-mcp-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@baton.local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Baton Test"', { cwd: dir, stdio: 'pipe' });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function mcpExchange(repoDir: string, requests: object[]): Promise<McpResponse[]> {
  return new Promise((resolve, reject) => {
    const runnerArgv = cliRunnerArgv();
    const child = spawn(runnerArgv[0]!, [...runnerArgv.slice(1), 'mcp'], {
      cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
    });
    let stdout = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', () => { /* ignore */ });
    child.on('error', reject);
    child.on('close', () => {
      const lines = stdout.trim().split('\n').filter(l => l.length > 0);
      resolve(lines.map(l => JSON.parse(l) as McpResponse));
    });
    for (const r of requests) {
      child.stdin?.write(JSON.stringify(r) + '\n');
    }
    child.stdin?.end();
  });
}

describe('Stage 5: baton mcp (stdio JSON-RPC)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    execSync(`${cliRunner()} init`, { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(async () => { await rm(repoDir, { recursive: true, force: true }); });

  it('initializes with server info and protocol version', async () => {
    const [init] = await mcpExchange(repoDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ]);
    expect(init.id).toBe(1);
    expect(init.result?.serverInfo?.name).toBe('baton');
    expect(init.result?.protocolVersion).toBeTruthy();
  });

  it('lists tools including read-only ledger tools', async () => {
    const [tools] = await mcpExchange(repoDir, [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const names = (tools.result?.tools ?? []).map(t => t.name);
    expect(names).toContain('list_tasks');
    expect(names).toContain('get_task');
    expect(names).toContain('get_packet');
    expect(names).toContain('status');
    expect(names).toContain('stale');
    expect(names).toContain('conflicts');
    expect(names).toContain('doctor');
    expect(names).toContain('search_events');
    // v1.3 orchestrator + retrieval tools
    expect(names).toContain('search_files');
    expect(names).toContain('next_task');
    expect(names).toContain('project_done');
    expect(names).toContain('list_workers');
    // verify must NOT be exposed: it executes untrusted worker code (G21)
    expect(names).not.toContain('verify');
  });

  it('answers async tool calls before exit and reports empty state', async () => {
    const responses = await mcpExchange(repoDir, [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_events', arguments: { limit: 5 } } },
    ]);
    expect(responses.length).toBe(3);
    const byId = new Map(responses.map(r => [r.id, r]));
    const status = byId.get(3);
    expect(status?.result?.content?.[0]?.text).toContain('No tasks');
    const tasks = byId.get(4);
    expect(tasks?.result?.content?.[0]?.text).toContain('No tasks found.');
    const search = byId.get(5);
    expect(search?.result?.content?.[0]?.text).toContain('total: 0');
  });

  it('v1.3 tools: next_task, project_done, search_files, list_workers respond', async () => {
    const responses = await mcpExchange(repoDir, [
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'next_task', arguments: {} } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'project_done', arguments: {} } },
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'search_files', arguments: { query: 'test readme' } } },
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'list_workers', arguments: {} } },
    ]);
    expect(responses.length).toBe(4);
    const byId = new Map(responses.map(r => [r.id, r]));
    const nextTask = byId.get(10);
    expect(nextTask?.result?.content?.[0]?.text).toContain('No eligible task');
    const projDone = byId.get(11);
    expect(projDone?.result?.content?.[0]?.text).toContain('BATON: NOT DONE');
    const fileSearch = byId.get(12);
    expect(fileSearch?.result?.content?.[0]?.text).toContain('README.md');
    const workerList = byId.get(13);
    expect(workerList?.result?.content?.[0]?.text).toContain('No worker reputation');
  });

  it('returns -32601 for unknown methods and -32700 for malformed JSON', async () => {
    const runnerArgv = cliRunnerArgv();
    const child = spawn(runnerArgv[0]!, [...runnerArgv.slice(1), 'mcp'], {
      cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
    });
    let stdout = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stdin?.write('this is not json\n');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'no/such/method' }) + '\n');
    child.stdin?.end();
    await new Promise<void>(resolve => child.on('close', () => resolve()));

    const responses = stdout.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as McpResponse);
    const parseError = responses.find(r => r.id === null);
    expect(parseError?.error?.code).toBe(-32700);
    const notFound = responses.find(r => r.id === 9);
    expect(notFound?.error?.code).toBe(-32601);
  });
});
