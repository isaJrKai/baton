// v1.3.2 P1: execution.sandbox policy — none (default) or docker. When docker
// is selected, cmd checks are wrapped in a no-network container whose only
// writable view is the worktree. Doctor warns when unsandboxed cmd execution
// is configured outside CI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PolicySchema } from '../../src/core/schemas.js';
import { dockerWrap } from '../../src/core/check-engine.js';
import { doctor } from '../../src/commands/doctor.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('execution.sandbox policy (v1.3.2 P1)', () => {
  it('defaults to none', () => {
    const p = PolicySchema.parse({ baton_version: 1 });
    expect(p.execution.sandbox).toBe('none');
  });
  it('accepts docker', () => {
    const p = PolicySchema.parse({ baton_version: 1, execution: { sandbox: 'docker', docker_image: 'node:20' } });
    expect(p.execution.sandbox).toBe('docker');
    expect(p.execution.docker_image).toBe('node:20');
  });
  it('rejects unknown sandbox values', () => {
    expect(() => PolicySchema.parse({ baton_version: 1, execution: { sandbox: 'fleet' } })).toThrow();
  });
});

describe('dockerWrap (v1.3.2 P1)', () => {
  it('wraps argv with no-network and worktree-only mount', () => {
    const argv = dockerWrap(['npm', 'test'], '/repo/.baton/tmp/wt-1', 'node:20');
    expect(argv[0]).toBe('docker');
    expect(argv[1]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('--network=none');
    const joined = argv.join(' ');
    expect(joined).toContain('-v /repo/.baton/tmp/wt-1:/repo/.baton/tmp/wt-1');
    expect(joined).toContain('-w /repo/.baton/tmp/wt-1');
    // image directly precedes the wrapped argv
    const imageIdx = argv.indexOf('node:20');
    expect(imageIdx).toBeGreaterThan(0);
    expect(argv.slice(imageIdx + 1)).toEqual(['npm', 'test']);
  });
});

describe('doctor sandbox warning (v1.3.2 P1)', () => {
  let dir: string;
  const prevCI = process.env.CI;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'baton-doctor-sandbox-'));
    await mkdir(path.join(dir, '.baton'), { recursive: true });
    delete process.env.CI;
  });
  afterEach(async () => {
    if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
    await rm(dir, { recursive: true, force: true });
  });

  async function writePolicy(policyYaml: string): Promise<void> {
    await writeFile(path.join(dir, '.baton', 'policy.yml'), policyYaml);
  }

  it('warns when cmd commands are allowed but sandbox is none outside CI', async () => {
    await writePolicy('baton_version: 1\nallowed_commands:\n  - "node *"\n');
    const { findings } = await doctor(dir);
    const w = findings.find(f => f.code === 'W_SANDBOX_NONE');
    expect(w).toBeDefined();
    expect(w?.message).toContain('worker-written code');
  });

  it('does not warn when allowed_commands is empty (cmd checks cannot run)', async () => {
    await writePolicy('baton_version: 1\nallowed_commands: []\n');
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'W_SANDBOX_NONE')).toBeUndefined();
  });

  it('does not warn when sandbox is docker', async () => {
    await writePolicy('baton_version: 1\nallowed_commands:\n  - "node *"\nexecution:\n  sandbox: docker\n  docker_image: "node:20"\n');
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'W_SANDBOX_NONE')).toBeUndefined();
  });

  it('does not warn inside CI', async () => {
    process.env.CI = '1';
    await writePolicy('baton_version: 1\nallowed_commands:\n  - "node *"\n');
    const { findings } = await doctor(dir);
    expect(findings.find(f => f.code === 'W_SANDBOX_NONE')).toBeUndefined();
  });
});
