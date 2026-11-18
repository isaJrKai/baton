// baton log command. Spec §7.3a.
// Prints ledger events one per line, sanitized (G18).
// [--task <T-id>] [--type <event-type>] [--last N] [--json]
import { readLedger } from '../io/ledger-file.js';

function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
}

export interface LogOpts {
  task?: string;
  type?: string;
  last?: number;
  json?: boolean;
}

export async function logCommand(repoRoot: string, opts: LogOpts = {}): Promise<void> {
  const { events, malformed } = await readLedger(repoRoot);

  let filtered = events;
  if (opts.task) {
    filtered = filtered.filter(e => 'task' in e && e.task === opts.task);
  }
  if (opts.type) {
    filtered = filtered.filter(e => e.type === opts.type);
  }

  const lastN = opts.last ?? 20;
  const toShow = filtered.slice(-lastN);

  if (opts.json) {
    // Machine output: one JSON per line
    for (const e of toShow) {
      console.log(sanitize(JSON.stringify(e)));
    }
  } else {
    // Human output: timestamp type task summary
    for (const e of toShow) {
      const ts = e.ts ?? '';
      const type = e.type ?? '';
      let task = '';
      let detail = '';
      if ('task' in e) task = e.task;
      if ('claim_id' in e) detail = e.claim_id;
      if ('decision' in e) detail = e.decision;
      if ('verdict' in e) detail = e.verdict;
      if ('reason' in e) detail = (e.reason as string).slice(0, 60);
      const line = `${ts} ${type} ${task} ${detail}`.trim().replace(/\s+/g, ' ');
      console.log(sanitize(line));
    }
  }

  if (malformed.length > 0) {
    console.error(`Warning: ${malformed.length} malformed ledger line(s) skipped`);
  }
}
