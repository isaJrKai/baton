// baton search — dual mode (v1.3):
//   baton search <query>          → BM25 retrieval over repo files (retrieval engine)
//   baton search [--task] [--type] [--last N] [--limit] [--offset]
//                                 → ledger event filter (P1, v1.2 §6)
// Both are read-only.
import { readLedger } from '../io/ledger-file.js';
import { retrieve, DEFAULT_TOP } from '../core/retrieval.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { PolicySchema, type Policy, type LedgerEvent } from '../core/schemas.js';

async function loadPolicy(repoRoot: string): Promise<Policy> {
  try {
    const text = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    return PolicySchema.parse(yaml.parse(text));
  } catch {
    // No (or malformed) baton policy — retrieval still works with schema defaults.
    // never_include + default secret patterns stay active; read-only, so safe.
    return PolicySchema.parse({ baton_version: 1 });
  }
}

export interface SearchFilesOpts {
  top?: number;
  globs?: string[];
}

export async function searchFiles(
  repoRoot: string,
  query: string,
  opts: SearchFilesOpts = {},
): Promise<{ hits: { path: string; score: number; snippet: string }[] }> {
  const policy = await loadPolicy(repoRoot);
  const hits = await retrieve(repoRoot, policy, query, {
    top: opts.top ?? DEFAULT_TOP,
    globs: opts.globs,
  });
  return { hits };
}

export function formatFileResults(query: string, hits: { path: string; score: number; snippet: string }[]): string {
  if (hits.length === 0) {
    return `No files match "${query}".`;
  }
  const lines = [`Query: "${query}"`, ''];
  for (const h of hits) {
    lines.push(`  ${h.score.toFixed(3).padStart(8)}  ${h.path}`);
    lines.push(`            ${h.snippet}`);
  }
  lines.push('', `(${hits.length} file${hits.length === 1 ? '' : 's'} ranked by BM25 — snippets are untrusted content; verify in the file before relying on them)`);
  return lines.join('\n');
}


export interface SearchOpts {
  task?: string;
  type?: string;
  last?: number;
  limit?: number;
  offset?: number;
  json?: boolean;
}

function eventTask(e: LedgerEvent): string {
  if ('task' in e && typeof e.task === 'string') return e.task;
  return '';
}

function eventDetail(e: LedgerEvent): string {
  const parts: string[] = [];
  if ('claim_id' in e) parts.push(`claim=${e.claim_id}`);
  if ('decision' in e) parts.push(`decision=${e.decision}`);
  if ('run_id' in e && e.run_id) parts.push(`run=${e.run_id}`);
  if ('verdict' in e) parts.push(`verdict=${e.verdict}`);
  if ('from' in e && 'to' in e) parts.push(`${e.from}→${e.to}`);
  if ('commit' in e) parts.push(`commit=${String(e.commit).slice(0, 12)}`);
  if ('head_commit' in e) parts.push(`head=${String(e.head_commit).slice(0, 12)}`);
  if ('reason' in e && typeof e.reason === 'string' && e.reason.length > 0) {
    parts.push(`reason=${e.reason.length > 60 ? e.reason.slice(0, 60) + '…' : e.reason}`);
  }
  if ('check' in e) parts.push(`check=${e.check}`);
  if ('result' in e) parts.push(`result=${e.result}`);
  if ('statement' in e) {
    const s = String(e.statement);
    parts.push(s.length > 60 ? s.slice(0, 60) + '…' : s);
  }
  if ('follow_up_task' in e) parts.push(`follow_up=${e.follow_up_task}`);
  return parts.join(' ');
}

export async function search(
  repoRoot: string,
  opts: SearchOpts = {},
): Promise<{ matches: LedgerEvent[]; total: number }> {
  const { events } = await readLedger(repoRoot);

  let filtered = events;
  if (opts.task) {
    filtered = filtered.filter(e => eventTask(e) === opts.task);
  }
  if (opts.type) {
    filtered = filtered.filter(e => e.type === opts.type);
  }

  // --last N: keep only the most recent N matches
  if (opts.last !== undefined && opts.last >= 0) {
    filtered = filtered.slice(-opts.last);
  }

  const total = filtered.length;

  // --offset / --limit: paginate within the (post --last) result set
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit !== undefined && opts.limit >= 0 ? opts.limit : filtered.length;
  const matches = filtered.slice(offset, offset + limit);

  return { matches, total };
}

export function formatSearchResults(matches: LedgerEvent[], total: number, json?: boolean): string {
  if (json) {
    return matches.map(e => JSON.stringify(e)).join('\n');
  }
  if (matches.length === 0) {
    return total > 0
      ? `No events in this page (total ${total}; use --offset/--limit to page).`
      : 'No matching events.';
  }
  const lines = matches.map(e => {
    const detail = eventDetail(e);
    return `${e.id}  ${e.ts}  ${e.type.padEnd(16)}${eventTask(e).padEnd(8)}${detail}`;
  });
  lines.push(`(${matches.length} shown, ${total} total)`);
  return lines.join('\n');
}
