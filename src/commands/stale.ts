// baton stale command. Spec §7.3a.
// Replays ledger. For every verified claim, compares blob IDs of watched files
// between anchor.commit and base tip (if task done) or branch tip (if not done).
// Appends claim_status stale events (deduped) unless --dry-run.
import { readLedger, appendLedger, nextEventId, claimStatusDedupeKey } from '../io/ledger-file.js';
import { withLock } from '../io/lock.js';
import { git, getCommitSha, getGitRoot } from '../io/git.js';
import { replay } from '../core/ledger-replay.js';
import { isMatch, expandGlob } from '../core/globs.js';
import { sha256Sync } from '../io/hash.js';
import * as yaml from 'yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function nowIso(): string { return new Date().toISOString(); }

interface StaleResult {
  taskId: string;
  claimId: string;
  reason: string;
}

async function getBlobIds(repoRoot: string, ref: string): Promise<Map<string, string>> {
  const gitRoot = await getGitRoot(repoRoot);
  const r = await git(['ls-tree', '-r', ref], { cwd: gitRoot });
  const result = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    // Format: <mode> <type> <blob>\t<path>
    const parts = line.split('\t');
    if (parts.length !== 2) continue;
    const meta = parts[0]!.split(' ');
    const blobId = meta[2];
    const filePath = parts[1];
    if (blobId && filePath) {
      result.set(filePath, blobId);
    }
  }
  return result;
}

export async function stale(repoRoot: string, opts: { dryRun?: boolean; baseBranch?: string } = {}): Promise<{ staleClaims: StaleResult[]; totalChecked: number }> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  // Load policy for base branch
  let baseBranch = opts.baseBranch ?? 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policyRaw = yaml.parse(policyText) as { default_branch?: string } | null;
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch { /* use default */ }

  const baseTip = await getCommitSha(repoRoot, baseBranch);
  const baseBlobs = await getBlobIds(repoRoot, baseBranch);

  const staleClaims: StaleResult[] = [];
  let totalChecked = 0;

  for (const [claimId, claim] of state.claims) {
    if (claim.status !== 'verified') continue;
    if (!claim.anchor) continue;

    totalChecked++;
    const anchorCommit = claim.anchor.commit;
    const watchGlobs = claim.anchor.watch.length > 0 ? claim.anchor.watch : [];

    // Get blob IDs at anchor commit
    const anchorBlobs = await getBlobIds(repoRoot, anchorCommit);

    // Determine the task's status
    const taskState = state.tasks.get(claim.taskId);
    const isDone = taskState?.status === 'done';

    if (isDone) {
      // Compare anchor blobs to base tip blobs for watched files
      for (const [filePath, anchorBlob] of anchorBlobs) {
        const isWatched = watchGlobs.length === 0 || watchGlobs.some(g => isMatch(filePath, g));
        if (!isWatched) continue;
        const baseBlob = baseBlobs.get(filePath);
        if (!baseBlob) {
          staleClaims.push({ taskId: claim.taskId, claimId, reason: 'watch_missing' });
          break;
        }
        if (baseBlob !== anchorBlob) {
          // Check if anchor commit is ancestor of base tip
          const mbResult = await git(['merge-base', '--is-ancestor', anchorCommit, baseTip], { cwd: repoRoot });
          if (mbResult.exitCode !== 0) {
            staleClaims.push({ taskId: claim.taskId, claimId, reason: 'differs_from_base' });
          } else {
            staleClaims.push({ taskId: claim.taskId, claimId, reason: 'changed_since_verified' });
          }
          break;
        }
      }
    } else {
      // Task not done: check if branch tip != anchor commit
      // For Stage 3 simplicity, just compare anchor commit to base tip
      if (anchorCommit !== baseTip) {
        staleClaims.push({ taskId: claim.taskId, claimId, reason: 'branch_moved' });
      }
    }
  }

  // Append stale events unless --dry-run
  if (!opts.dryRun && staleClaims.length > 0) {
    await withLock(repoRoot, async () => {
      const { events: currentEvents } = await readLedger(repoRoot);
      const seenKeys = new Set(
        currentEvents
          .filter(e => e.type === 'claim_status')
          .map(e => {
            const cs = e as { claim_id: string; status: string; anchor?: { commit: string }; run_id?: string };
            return claimStatusDedupeKey({ claim_id: cs.claim_id, status: cs.status, anchor: cs.anchor, run_id: cs.run_id });
          })
      );

      for (const sc of staleClaims) {
        const dedupeKey = claimStatusDedupeKey({
          claim_id: sc.claimId,
          status: 'stale',
          anchor: undefined,
          run_id: undefined,
        });
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const eventId = await nextEventId(repoRoot);
        await appendLedger(repoRoot, {
          v: 1, id: eventId, ts: nowIso(),
          type: 'claim_status',
          claim_id: sc.claimId,
          status: 'stale',
          reason: sc.reason,
        });
      }
    });
  }

  return { staleClaims, totalChecked };
}

export function formatStaleTable(result: { staleClaims: StaleResult[]; totalChecked: number }): string {
  const lines: string[] = [];
  lines.push(`Staleness check: ${result.totalChecked} verified claims checked, ${result.staleClaims.length} stale.`);
  if (result.staleClaims.length > 0) {
    lines.push('');
    lines.push('CLAIM       TASK     REASON');
    for (const sc of result.staleClaims) {
      lines.push(`${sc.claimId.padEnd(12)} ${sc.taskId.padEnd(8)} ${sc.reason}`);
    }
  } else {
    lines.push('No stale claims.');
  }
  return lines.join('\n');
}
