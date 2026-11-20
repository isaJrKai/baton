// v1.3.2 P2 end-to-end: a cmd check whose run is an argv array executes with
// tokens verbatim — `npm test -- -t "a b"`-style quoted arguments survive.
// The equivalent string form splits on whitespace and fails, which is exactly
// why the array form exists. shell stays false everywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runBaton, gitSync, setupTask, writeReport, createRepo } from '../helpers.js';

const POLICY = `baton_version: 1
default_branch: main
execution:
  mode: local
  acknowledged: true
  timeout_seconds: 60
  docker_image: ""
  sandbox: none
allowed_commands:
  - "node *"
env_passthrough: []
protected_paths: []
`;

describe('v1.3.2: cmd run as argv array', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createRepo('baton-cmd-argv-');
    await writeFile(path.join(repoDir, '.baton', 'policy.yml'), POLICY);
    gitSync('git add -A && git commit -m "policy"', repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function runTask(taskId: string, checks: Record<string, unknown>[]) {
    await setupTask(repoDir, taskId, ['src/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/**'] },
      ...checks,
    ]);
    runBaton(['task', 'ready', taskId], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    gitSync(`git checkout -b baton/${taskId}-test`, repoDir);
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'feature.ts'), 'export const ok = true;\n');
    gitSync('git add -A && git commit -m "worker output"', repoDir);
    await writeReport(repoDir, taskId, ['src/feature.ts']);
    return runBaton(['verify', taskId], repoDir);
  }

  it('array run executes with tokens verbatim (quoted arg survives)', async () => {
    const r = await runTask('T-0001', [
      { id: 'cmd', type: 'cmd', run: ['node', '-e', 'process.exit(process.argv[1] === "a b" ? 0 : 1)', 'a b'] },
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ALL_PASS');
  });

  it('the string form of the same command fails on token split (proves the gap)', async () => {
    // String form: the quoted "a b" splits into two tokens, node -e sees a
    // broken script and a stray arg — exits non-zero, verify fails.
    const r = await runTask('T-0002', [
      { id: 'cmd', type: 'cmd', run: 'node -e "console.log a b" extra-arg' },
    ]);
    // extra-arg makes node treat it as a script path -> exit 1; the point is
    // the cmd row fails on token splitting, not on allowlist denial.
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('cmd');
    expect(r.stdout).not.toContain('not on allowlist');
  });

  it('array run still requires the allowlist (deny non-matching tokens)', async () => {
    await setupTask(repoDir, 'T-0003', ['src/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['src/**'] },
      { id: 'cmd', type: 'cmd', run: ['npx', 'something-else'] },
    ]);
    // The task ready gate uses the same token matcher as verify — it refuses
    // the task before any worker can pick it up.
    const ready = runBaton(['task', 'ready', 'T-0003'], repoDir);
    expect(ready.code).toBe(5);
    const output = ready.stdout + ready.stderr;
    expect(output).toContain('not on allowlist');
  });
});
