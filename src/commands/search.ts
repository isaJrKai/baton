// baton search — search the ledger. P1 (v1.2 §6): search [--task] [--type] [--last N] [--limit] [--offset].
// Read-only: filters ledger events and prints them oldest-first (after pagination).
import { readLedger } from '../io/ledger-file.js';
import type { LedgerEvent } from '../core/schemas.js';

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
