// v1.3.3 red-team finding (MEDIUM): verify-then-accept race.
// Verified an honest commit (ALL_PASS), then pushed a backdoor commit to the
// same branch — accept still said "accepted at <sha>" and never warned the
// branch had moved. It records the right SHA (so merging THAT sha is safe),
// but an operator merging the branch ships unreviewed commits.
//
// Contract after the fix:
//   - accept resolves every baton/<taskId>-* branch and fails (exit 4) when
//     any tip is NOT part of the verified head's history (fast-forward ahead
//     or force-push rewrite) — regardless of which branch is checked out.
//   - --allow-moved is the explicit escape hatch: binds to the verified sha
//     and records branch_moved + branch_tip in the accepted event.
//   - honest flow (no movement) is unchanged.

import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createRepo, runBaton, gitSync, setupTask, writeReport } from '../helpers.js';

const repos: string[] = [];
async function freshRepo(): Promise<string> {
  const dir = await createRepo('baton-accept-race-');
  repos.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of repos.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Set up a task, a worker branch with code + report, verify it (ALL_PASS)
 * from main, and return { repoDir, verifiedHead }.
 */
async function setupVerified(): Promise<{ repoDir: string; verifiedHead: string }> {
  const repoDir = await freshRepo();
  await setupTask(repoDir, 'T-0001', ['src/**'], [
    { id: 'scope', type: 'diff_scope', allow: ['src/**'] },
    { id: 'secrets', type: 'no_secrets' },
  ]);
  runBaton(['task', 'ready', 'T-0001'], repoDir);
  gitSync('git add -A && git commit -m "ready" --allow-empty', repoDir);

  gitSync('git checkout -b baton/T-0001-test', repoDir);
  await mkdir(path.join(repoDir, 'src'), { recursive: true });
  await writeFile(path.join(repoDir, 'src/impl.ts'), 'export const impl = () => 1;\n');
  gitSync('git add -A && git commit -m "worker output"', repoDir);
  await writeReport(repoDir, 'T-0001', ['src/impl.ts']);
  const verifiedHead = gitSync('git rev-parse HEAD', repoDir);

  // Operator flow: verify from the base branch, then commit the ledger so the
  // verify events survive branch switches below.
  gitSync('git checkout main', repoDir);
  const v = runBaton(['verify', 'T-0001'], repoDir);
  expect(v.code).toBe(0);
  expect(v.stdout).toContain('ALL_PASS');
  gitSync('git add -A && git commit -m "ledger: verify" --allow-empty', repoDir);
  return { repoDir, verifiedHead };
}

describe('accept binds to the exact verified commit (v1.3.3)', () => {
  it('FAILS when a fast-forward commit is added to the worker branch after verify', async () => {
    const { repoDir, verifiedHead } = await setupVerified();

    // The exploit: push a backdoor commit on top of the verified head.
    gitSync('git checkout baton/T-0001-test', repoDir);
    await writeFile(path.join(repoDir, 'src/impl.ts'), 'export const impl = () => 1;\nexport const backdoor = true;\n');
    gitSync('git add -A && git commit -m "backdoor"', repoDir);
    gitSync('git checkout main', repoDir);

    const a = runBaton(['accept', 'T-0001'], repoDir);
    expect(a.code).toBe(4);
    expect(a.stderr).toContain('moved since verify');
    expect(a.stderr).toContain('Re-verify');
    // The refusal must name both the verified head and the moved tip.
    expect(a.stderr).toContain(verifiedHead.slice(0, 12));
  });

  it('FAILS when the worker branch was rewritten (force-push) after verify — even from main', async () => {
    const { repoDir } = await setupVerified();

    // Rewrite the branch so the verified head is unreachable from the tip.
    gitSync('git checkout baton/T-0001-test', repoDir);
    gitSync('git reset --hard main', repoDir);
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src/rewritten.ts'), 'export const r = 1;\n');
    gitSync('git add -A && git commit -m "rewritten worker output"', repoDir);
    await writeReport(repoDir, 'T-0001', ['src/rewritten.ts']);
    gitSync('git checkout main', repoDir);

    const a = runBaton(['accept', 'T-0001'], repoDir);
    expect(a.code).toBe(4);
    expect(a.stderr).toContain('moved since verify');
  });

  it('--allow-moved accepts the verified sha and records branch_moved in the ledger', async () => {
    const { repoDir, verifiedHead } = await setupVerified();

    gitSync('git checkout baton/T-0001-test', repoDir);
    await writeFile(path.join(repoDir, 'src/impl.ts'), 'export const impl = () => 1;\nexport const backdoor = true;\n');
    gitSync('git add -A && git commit -m "backdoor"', repoDir);
    const movedTip = gitSync('git rev-parse baton/T-0001-test', repoDir);
    gitSync('git checkout main', repoDir);

    const a = runBaton(['accept', 'T-0001', '--allow-moved'], repoDir);
    expect(a.code).toBe(0);
    // Binds to the VERIFIED sha, not the moved tip.
    expect(a.stdout).toContain(verifiedHead.slice(0, 12));

    const ledgerText = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const events = ledgerText.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>);
    const accepted = events.find(e => e.type === 'accepted') as Record<string, unknown> | undefined;
    expect(accepted).toBeDefined();
    expect(accepted?.commit).toBe(verifiedHead);
    expect(accepted?.branch_moved).toBe(true);
    expect(accepted?.branch_tip).toBe(movedTip);
  });

  it('honest flow unchanged: verify then accept with no movement succeeds', async () => {
    const { repoDir, verifiedHead } = await setupVerified();

    const a = runBaton(['accept', 'T-0001'], repoDir);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('accepted');
    expect(a.stdout).toContain(verifiedHead.slice(0, 12));

    // The accepted event records the verified commit and no movement markers.
    const ledgerText = await readFile(path.join(repoDir, 'project-memory/ledger.jsonl'), 'utf8');
    const events = ledgerText.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>);
    const accepted = events.find(e => e.type === 'accepted') as Record<string, unknown> | undefined;
    expect(accepted?.commit).toBe(verifiedHead);
    expect(accepted?.branch_moved).toBeUndefined();
  });

  it('accept still works after the moved branch is re-verified at its new tip', async () => {
    const { repoDir } = await setupVerified();

    gitSync('git checkout baton/T-0001-test', repoDir);
    await writeFile(path.join(repoDir, 'src/impl.ts'), 'export const impl = () => 2;\n');
    gitSync('git add -A && git commit -m "legit follow-up commit"', repoDir);
    await writeReport(repoDir, 'T-0001', ['src/impl.ts']);
    gitSync('git checkout main', repoDir);

    // First accept refuses...
    const a1 = runBaton(['accept', 'T-0001'], repoDir);
    expect(a1.code).toBe(4);
    expect(a1.stderr).toContain('moved since verify');

    // ...re-verify at the new tip, then accept succeeds.
    const v2 = runBaton(['verify', 'T-0001'], repoDir);
    expect(v2.code).toBe(0);
    expect(v2.stdout).toContain('ALL_PASS');
    const a2 = runBaton(['accept', 'T-0001'], repoDir);
    expect(a2.code).toBe(0);
    expect(a2.stdout).toContain('accepted');
  });
});
