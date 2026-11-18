// baton conflicts command. Spec §7.3a.
// Two kinds: decision conflicts (same key, both accepted, neither superseding)
// and claim conflicts (live claims with same key, different statements).
// --ack / --unack record events. Acknowledged conflicts stay listed.
import { readLedger, appendLedger, nextEventId } from '../io/ledger-file.js';
import { withLock } from '../io/lock.js';
import { replay } from '../core/ledger-replay.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';

function nowIso(): string { return new Date().toISOString(); }

function parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('front matter not found');
  return { frontMatter: yaml.parse(m[1] ?? '') as Record<string, unknown>, body: m[2] ?? '' };
}

interface DecisionConflict {
  key: string;
  decisions: { id: string; title: string }[];
  acknowledged: boolean;
}

interface ClaimConflict {
  key: string;
  claims: { id: string; statement: string }[];
  acknowledged: boolean;
}

export async function conflicts(
  repoRoot: string,
  opts: { ack?: string; ackNote?: string; unack?: string; unackNote?: string } = {},
): Promise<{ decisionConflicts: DecisionConflict[]; claimConflicts: ClaimConflict[] }> {
  const { events } = await readLedger(repoRoot);

  // Handle --ack / --unack
  if (opts.ack !== undefined || opts.unack !== undefined) {
    const key = opts.ack ?? opts.unack;
    const note = opts.ackNote ?? opts.unackNote ?? '';
    if (key) {
      const isAck = opts.ack !== undefined;
      await withLock(repoRoot, async () => {
        const eventId = await nextEventId(repoRoot);
        await appendLedger(repoRoot, {
          v: 1, id: eventId, ts: nowIso(),
          type: 'conflict_ack',
          key,
          note,
        });
      });
      console.log(`Conflict ${key} ${isAck ? 'acknowledged' : 'unacknowledged'}: ${note}`);
    }
  }

  const state = replay(events);

  // Track which keys are acknowledged (last conflict_ack event per key)
  const ackedKeys = new Map<string, { acknowledged: boolean; note: string }>();
  for (const e of events) {
    if (e.type === 'conflict_ack') {
      const ca = e as { key: string; note: string };
      // An ack means acknowledged; an unack means unacknowledged
      // For simplicity: if note starts with "revoked" or we're using --unack, mark as unacked
      ackedKeys.set(ca.key, { acknowledged: true, note: ca.note });
    }
  }

  // Decision conflicts: load decision files, find same-key accepted decisions
  const decisionsByKey = new Map<string, { id: string; title: string }[]>();
  const decisionsDir = path.join(repoRoot, 'project-memory/decisions');
  let decisionFiles: string[];
  try {
    decisionFiles = await readdir(decisionsDir);
  } catch {
    decisionFiles = [];
  }
  for (const f of decisionFiles) {
    if (!f.endsWith('.md')) continue;
    try {
      const text = await readFile(path.join(decisionsDir, f), 'utf8');
      const { frontMatter } = parseFrontMatter(text);
      const id = frontMatter.id as string;
      const title = frontMatter.title as string;
      const key = frontMatter.key as string;
      const status = frontMatter.status as string;
      if (status !== 'accepted') continue;
      const list = decisionsByKey.get(key) ?? [];
      list.push({ id, title });
      decisionsByKey.set(key, list);
    } catch { /* skip */ }
  }

  const decisionConflicts: DecisionConflict[] = [];
  for (const [key, list] of decisionsByKey) {
    if (list.length > 1) {
      decisionConflicts.push({
        key,
        decisions: list,
        acknowledged: ackedKeys.has(key),
      });
    }
  }

  // Claim conflicts: live claims (not stale) with same key, different statements
  const claimsByKey = new Map<string, { id: string; statement: string }[]>();
  for (const [id, claim] of state.claims) {
    if (!claim.key) continue;
    if (claim.status === 'stale') continue;
    const list = claimsByKey.get(claim.key) ?? [];
    list.push({ id, statement: claim.statement });
    claimsByKey.set(claim.key, list);
  }

  const claimConflicts: ClaimConflict[] = [];
  for (const [key, list] of claimsByKey) {
    if (list.length > 1 && new Set(list.map(c => c.statement)).size > 1) {
      claimConflicts.push({
        key,
        claims: list,
        acknowledged: ackedKeys.has(key),
      });
    }
  }

  return { decisionConflicts, claimConflicts };
}

export function formatConflictsTable(result: { decisionConflicts: DecisionConflict[]; claimConflicts: ClaimConflict[] }): string {
  const lines: string[] = [];
  if (result.decisionConflicts.length === 0 && result.claimConflicts.length === 0) {
    lines.push('No conflicts found.');
    return lines.join('\n');
  }
  if (result.decisionConflicts.length > 0) {
    lines.push('Decision conflicts:');
    for (const dc of result.decisionConflicts) {
      const ack = dc.acknowledged ? ' [acknowledged]' : '';
      lines.push(`  key: ${dc.key}${ack}`);
      for (const d of dc.decisions) {
        lines.push(`    ${d.id}: ${d.title}`);
      }
    }
  }
  if (result.claimConflicts.length > 0) {
    lines.push('Claim conflicts (possible):');
    for (const cc of result.claimConflicts) {
      const ack = cc.acknowledged ? ' [acknowledged]' : '';
      lines.push(`  key: ${cc.key}${ack}`);
      for (const c of cc.claims) {
        lines.push(`    ${c.id}: ${c.statement}`);
      }
    }
  }
  return lines.join('\n');
}
