// baton status command. Spec §7.3a.
// Default: 24-line summary. --verbose: full lists.
// Rewrites the generated region of STATE.md.
import { readLedger } from '../io/ledger-file.js';
import { replay } from '../core/ledger-replay.js';
import { getCommitSha } from '../io/git.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';

const START_MARKER = '<!-- baton:generated -->';
const END_MARKER = '<!-- /baton:generated -->';

interface StatusResult {
  counts: Record<string, number>;
  needsAttention: { type: string; detail: string }[];
  nextAction: string;
  baseSha: string;
  staleCount: number;
  conflictCount: number;
}

export async function status(repoRoot: string, opts: { verbose?: boolean; json?: boolean; baseBranch?: string } = {}): Promise<StatusResult> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  let baseBranch = opts.baseBranch ?? 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policyRaw = yaml.parse(policyText) as { default_branch?: string } | null;
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch { /* use default */ }

  let baseSha = 'unknown';
  try { baseSha = (await getCommitSha(repoRoot, baseBranch)).slice(0, 12); } catch { /* ignore */ }

  // Count tasks by status
  const counts: Record<string, number> = {};
  for (const [, t] of state.tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }

  // Stale claims count
  const staleCount = Array.from(state.claims.values()).filter(c => c.status === 'stale').length;

  // Needs attention
  const needsAttention: { type: string; detail: string }[] = [];
  for (const [id, t] of state.tasks) {
    if (t.status === 'needs_work') {
      needsAttention.push({ type: 'needs_work', detail: id });
    }
    if (t.status === 'blocked') {
      needsAttention.push({ type: 'blocked', detail: id });
    }
  }
  if (staleCount > 0) {
    needsAttention.push({ type: 'stale', detail: `${staleCount} stale claims` });
  }

  const conflictCount = 0; // conflicts command handles this; status just counts
  const nextAction = needsAttention.length > 0
    ? `Review ${needsAttention.length} item(s) needing attention.`
    : 'No items need attention. Ready for new work.';

  // Rewrite STATE.md generated region
  const statePath = path.join(repoRoot, 'project-memory/STATE.md');
  try {
    const stateText = await readFile(statePath, 'utf8');
    if (stateText.includes(START_MARKER) && stateText.includes(END_MARKER)) {
      const generated = formatGeneratedBlock(counts, staleCount, conflictCount, baseSha);
      const startIdx = stateText.indexOf(START_MARKER);
      const endIdx = stateText.indexOf(END_MARKER) + END_MARKER.length;
      const updated = stateText.slice(0, startIdx) + generated + stateText.slice(endIdx);
      await writeFile(statePath, updated, 'utf8');
    }
  } catch { /* STATE.md may not exist */ }

  return { counts, needsAttention, nextAction, baseSha, staleCount, conflictCount };
}

function formatGeneratedBlock(counts: Record<string, number>, stale: number, conflicts: number, baseSha: string): string {
  const parts: string[] = [];
  for (const [status, count] of Object.entries(counts)) {
    parts.push(`${count} ${status}`);
  }
  if (stale > 0) parts.push(`${stale} stale`);
  if (conflicts > 0) parts.push(`${conflicts} conflict`);
  const countsLine = parts.length > 0 ? parts.join(' · ') : 'no tasks';

  return `${START_MARKER}\nOpen tasks: ${countsLine}\nAs of base ${baseSha}\n${END_MARKER}`;
}

export function formatStatusOutput(result: StatusResult, verbose?: boolean): string {
  const lines: string[] = [];
  // Counts line first
  const parts: string[] = [];
  for (const [status, count] of Object.entries(result.counts)) {
    parts.push(`${count} ${status}`);
  }
  if (result.staleCount > 0) parts.push(`${result.staleCount} stale`);
  lines.push(parts.length > 0 ? parts.join(' · ') : 'No tasks.');
  lines.push(`As of base ${result.baseSha}`);
  lines.push('');

  // Needs attention
  if (result.needsAttention.length > 0) {
    lines.push('Needs attention:');
    for (const item of result.needsAttention) {
      lines.push(`  ${item.type}: ${item.detail}`);
    }
    lines.push('');
  }

  // Next action
  lines.push(`Next: ${result.nextAction}`);

  if (verbose) {
    lines.push('');
    lines.push('(use --json for full machine output)');
  }

  return lines.join('\n');
}
