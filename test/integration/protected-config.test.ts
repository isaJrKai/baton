// v1.3.2 P2 end-to-end: the protected_paths default now guards the files that
// define how tests run. Worker edits to the package.json `scripts` block are
// protected (verify restores the base version + fails the row); dependency-only
// edits stay allowed; tsconfig/Makefile-style config is protected too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBaton, gitSync, setupTask, writeReport, createRepo } from '../helpers.js';

function pkgJson(scripts: Record<string, string>, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'demo', private: true, scripts, dependencies: deps }, null, 2) + '\n';
}

describe('v1.3.2: protected test-runner config', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createRepo('baton-protcfg-');
    // Seed a package.json so the protected-path machinery has something to compare
    await writeFile(path.join(repoDir, 'package.json'),
      pkgJson({ test: 'node test.js' }, { left_pad: '1.0.0' }));
    await writeFile(path.join(repoDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
    gitSync('git add -A && git commit -m "seed config"', repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function runWorkerTask(taskId: string, workerPackageJson: string, extraFiles: Record<string, string> = {}) {
    await setupTask(repoDir, taskId, ['package.json', 'tsconfig.json', 'src/**'], [
      { id: 'scope', type: 'diff_scope', allow: ['package.json', 'tsconfig.json', 'src/**'] },
    ]);
    runBaton(['task', 'ready', taskId], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);
    gitSync(`git checkout -b baton/${taskId}-test`, repoDir);
    await writeFile(path.join(repoDir, 'package.json'), workerPackageJson);
    for (const [p, c] of Object.entries(extraFiles)) {
      const { mkdir } = await import('node:fs/promises');
      const abs = path.join(repoDir, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    gitSync('git add -A && git commit -m "worker output"', repoDir);
    const changed = ['package.json', ...Object.keys(extraFiles)];
    await writeReport(repoDir, taskId, changed);
    return runBaton(['verify', taskId], repoDir);
  }

  it('worker editing the scripts block is protected (row fails, base restored)', async () => {
    const r = await runWorkerTask('T-0001',
      pkgJson({ test: 'node test.js', postinstall: 'echo pwned' }, { left_pad: '1.0.0' }));
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('protected_paths');
  });

  it('dependency-only edits stay allowed (no protected row)', async () => {
    const r = await runWorkerTask('T-0002',
      pkgJson({ test: 'node test.js' }, { left_pad: '1.0.0', right_pad: '2.0.0' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ALL_PASS');
    expect(r.stdout).not.toContain('protected_paths');
  });

  it('tsconfig.json is protected by the new default', async () => {
    const r = await runWorkerTask('T-0003',
      pkgJson({ test: 'node test.js' }, { left_pad: '1.0.0' }),
      { 'tsconfig.json': '{"compilerOptions":{"strict":false}}\n' });
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('protected_paths');
    expect(r.stdout).toContain('tsconfig.json');
  });
});
