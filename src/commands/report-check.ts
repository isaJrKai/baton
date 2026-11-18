// baton report check command. Spec §5.4.
// Validates report schema, confirms commits, compares changed_files with git diff.
// Appends report_checked event + one claim event per new claim.
// P0-7: report_matches (in verify) is fail-on-missing, not skip.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { ReportSchema, type Report } from '../core/schemas.js';
import { withLock } from '../io/lock.js';
import { appendLedger, readLedger, nextEventId, nextClaimId, claimDedupeKey } from '../io/ledger-file.js';
import { sha256Sync } from '../io/hash.js';
import { diffNameOnly, getCommitSha } from '../io/git.js';
import { assertOnBaseBranch } from '../io/branch-guard.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('front matter not found');
  const fm = yaml.parse(m[1] ?? '') as Record<string, unknown>;
  const body = m[2] ?? '';
  return { frontMatter: fm, body };
}

export interface ReportCheckResult {
  valid: boolean;
  reportSha: string;
  missingInReport: string[];
  extraInReport: string[];
  claimsAdded: number;
  headMatchesBranch: boolean;
  errors: string[];
}

export async function reportCheck(
  repoRoot: string,
  reportPath: string,
  opts: { allowBranch?: boolean; baseBranch?: string } = {},
): Promise<ReportCheckResult> {
  await assertOnBaseBranch(repoRoot, opts.baseBranch ?? 'main', { allowBranch: opts.allowBranch });
  // Resolve and verify path is project-memory/reports/R-XXXX.md
  const absPath = path.resolve(repoRoot, reportPath);
  const relPath = path.relative(repoRoot, absPath);
  const match = relPath.match(/^project-memory\/reports\/R-(\d{4})\.md$/);
  if (!match) {
    const err = new Error(`report path must be project-memory/reports/R-XXXX.md, got: ${relPath}`);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const taskNum = match[1];
  const taskId = `T-${taskNum}`;

  // Read report
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    const err = new Error(`report not found: ${reportPath}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }
  const { frontMatter } = parseFrontMatter(text);
  const report = ReportSchema.parse(frontMatter);

  // Verify task ID matches
  if (report.task !== taskId) {
    const err = new Error(`report task ${report.task} does not match path task ${taskId}`);
    (err as Error & { exitCode?: number }).exitCode = 3;
    throw err;
  }

  const errors: string[] = [];

  // Compute report hash
  const reportSha = sha256Sync(text);

  // Compare changed_files to git diff
  let missingInReport: string[] = [];
  let extraInReport: string[] = [];
  let headMatchesBranch = true;

  try {
    const diffFiles = await diffNameOnly(repoRoot, report.base_commit, report.head_commit);
    const reportSet = new Set(report.changed_files);
    const diffSet = new Set(diffFiles);
    missingInReport = diffFiles.filter(f => !reportSet.has(f));
    extraInReport = report.changed_files.filter(f => !diffSet.has(f));

    // Verify head_commit is reachable
    try {
      await getCommitSha(repoRoot, report.head_commit);
    } catch {
      headMatchesBranch = false;
      errors.push(`head_commit ${report.head_commit} not reachable in this repo`);
    }
  } catch (err) {
    errors.push(`git diff failed: ${(err as Error).message}`);
  }

  // Append report_checked event + claim events under lock
  let claimsAdded = 0;
  await withLock(repoRoot, async () => {
    const eventId = await nextEventId(repoRoot);
    await appendLedger(repoRoot, {
      v: 1, id: eventId, ts: nowIso(),
      type: 'report_checked',
      task: taskId,
      report_sha256: reportSha,
      missing_in_report: missingInReport,
      extra_in_report: extraInReport,
      head_matches_branch: headMatchesBranch,
    });

    // Add claim events (deduped by P0-5: task+statement+key)
    const { events } = await readLedger(repoRoot);
    const existingClaimKeys = new Set(
      events
        .filter(e => e.type === 'claim')
        .map(e => claimDedupeKey({
          task: (e as { task: string }).task,
          statement: (e as { statement: string }).statement,
          key: 'key' in e ? (e as { key?: string }).key : undefined,
        }))
    );

    for (const claim of report.claims) {
      const key = claimDedupeKey({
        task: taskId,
        statement: claim.statement,
        key: claim.key,
      });
      if (existingClaimKeys.has(key)) continue;
      existingClaimKeys.add(key);
      const claimId = await nextClaimId(repoRoot);
      const claimEventId = await nextEventId(repoRoot);
      await appendLedger(repoRoot, {
        v: 1, id: claimEventId, ts: nowIso(),
        type: 'claim',
        claim_id: claimId,
        task: taskId,
        statement: claim.statement,
        key: claim.key,
        report_sha256: reportSha,
      });
      claimsAdded++;
    }
  });

  const valid = errors.length === 0 && missingInReport.length === 0 && extraInReport.length === 0 && headMatchesBranch;

  // v1.2 §5.4: --strict removed. report check always exits 6 on mismatch.
  if (!valid) {
    const err = new Error(`report check failed: ${[...errors, missingInReport.length > 0 ? `missing ${missingInReport.length} files in report` : '', extraInReport.length > 0 ? `extra ${extraInReport.length} files in report` : ''].filter(Boolean).join('; ')}`);
    (err as Error & { exitCode?: number }).exitCode = 6;
    throw err;
  }

  return {
    valid,
    reportSha,
    missingInReport,
    extraInReport,
    claimsAdded,
    headMatchesBranch,
    errors,
  };
}
