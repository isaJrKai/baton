// v1.3.2 P3: settle the ALWAYS_DENIED semantics for build artifacts.
// Decision: dist/**, node_modules/**, .vite/** are violations unless the task's
// diff_scope allow list names them explicitly — that is what the code always
// did; the old comment claimed otherwise (and pathExplicitlyAllowed, dead since
// v1.3.1, was removed). dist/ is committed in this repo, so baton-on-baton
// tasks that rebuild dist need an explicit allow entry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runBaton, gitSync, setupTask, writeReport, createRepo } from '../helpers.js';

describe('v1.3.2: diff_scope build artifacts are deny-unless-allowed', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createRepo('baton-scope-art-');
    // dist/ is committed on main (as in the baton repo itself). The baton
    // scaffold's .gitignore excludes dist/, so force-add — this mirrors a repo
    // that deliberately tracks build output.
    await mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log("v1");\n');
    gitSync('git add -A && git add -f dist/bundle.js && git commit -m "seed dist"', repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function worker(taskId: string, allow: string[], content: string) {
    await setupTask(repoDir, taskId, ['src/**', 'dist/**'], [
      { id: 'scope', type: 'diff_scope', allow },
    ]);
    runBaton(['task', 'ready', taskId], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    gitSync(`git checkout -b baton/${taskId}-test`, repoDir);
    await writeFile(path.join(repoDir, 'dist', 'bundle.js'), content);
    gitSync('git add -A && git commit -m "worker output"', repoDir);
    await writeReport(repoDir, taskId, ['dist/bundle.js']);
    return runBaton(['verify', taskId], repoDir);
  }

  it('changing dist/bundle.js without an explicit allow entry fails', async () => {
    const r = await worker('T-0001', ['src/**'], 'console.log("v2");\n');
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('denied path not in allow');
  });

  it('changing dist/bundle.js WITH an explicit allow entry passes', async () => {
    const r = await worker('T-0002', ['src/**', 'dist/**'], 'console.log("v2");\n');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ALL_PASS');
  });
});
