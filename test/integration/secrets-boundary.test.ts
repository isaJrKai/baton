// v1.3.2 P1: no_secrets must fail when the worker ADDS a credential file,
// regardless of content — scanners can only catch secret-shaped strings, but a
// committed .env is a leak waiting to happen even when today's placeholders
// look innocent. Also covers the v1.3.2 scanner patterns end-to-end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runBaton, gitSync, setupTask, writeReport, createRepo } from '../helpers.js';

describe('v1.3.2: no_secrets boundary', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createRepo('baton-secrets-');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function runTaskWithAddedFile(taskId: string, filePath: string, content: string, allow: string[]) {
    await setupTask(repoDir, taskId, allow, [
      { id: 'scope', type: 'diff_scope', allow, description: 'scope' },
      { id: 'secrets', type: 'no_secrets' },
    ]);
    runBaton(['task', 'ready', taskId], repoDir);
    gitSync('git add -A && git commit -m "task ready"', repoDir);

    gitSync(`git checkout -b baton/${taskId}-test`, repoDir);
    const abs = path.join(repoDir, filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    gitSync('git add -A && git commit -m "worker output"', repoDir);
    await writeReport(repoDir, taskId, [filePath]);
    return runBaton(['verify', taskId], repoDir);
  }

  it('fails when the worker adds a .env file, even with harmless content', async () => {
    const r = await runTaskWithAddedFile('T-0001', '.env', '# environment\nAPP_MODE=development\n', ['.env']);
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('no_secrets');
    expect(r.stdout).toContain('.env');
    expect(r.stdout).toContain('credential file');
  });

  it('fails when the worker adds .env.local containing a connection string', async () => {
    const r = await runTaskWithAddedFile(
      'T-0002', '.env.local',
      'DATABASE_URL=postgresql://app_user:Zx9kQ2mLpR7vTn4Wb8@ep-x.neon.tech/db\n',
      ['.env.local'],
    );
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('no_secrets');
  });

  it('still passes a normal source file with no secrets (control)', async () => {
    const r = await runTaskWithAddedFile(
      'T-0003', 'src/config.ts',
      'export const APP_NAME = "demo";\nexport const PORT = 3000;\n',
      ['src/**'],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no_secrets');
  });
});
