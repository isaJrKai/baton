import { describe, it, expect } from 'vitest';
import { TaskSchema, DecisionSchema, ReportSchema, CheckSchema, LedgerEventSchema } from '../../src/core/schemas.js';

describe('CheckSchema — P0-1 (description field)', () => {
  it('accepts cmd check with description', () => {
    const check = CheckSchema.parse({
      id: 'tests',
      description: 'all tests pass',
      type: 'cmd',
      run: 'npm test',
    });
    expect(check.description).toBe('all tests pass');
  });
  it('accepts cmd check without description (optional)', () => {
    const check = CheckSchema.parse({
      id: 'tests',
      type: 'cmd',
      run: 'npm test',
    });
    expect(check.description).toBeUndefined();
  });
  it('rejects cmd check with forbidden chars in run', () => {
    const result = TaskSchema.safeParse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Test',
      touches: ['src/**'],
      checks: [{ id: 'tests', type: 'cmd', run: 'npm test; rm -rf /' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('TaskSchema', () => {
  it('accepts valid task', () => {
    const task = TaskSchema.parse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Test task',
      touches: ['src/**', 'test/**'],
      checks: [
        { id: 'scope', type: 'diff_scope', allow: ['src/**', 'test/**'] },
        { id: 'secrets', type: 'no_secrets' },
      ],
    });
    expect(task.id).toBe('T-0001');
  });
  it('rejects touches with backslashes (Windows path)', () => {
    const result = TaskSchema.safeParse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Test',
      touches: ['src\\api\\**'],
      checks: [{ id: 'scope', type: 'diff_scope', allow: ['src\\api\\**'] }],
    });
    expect(result.success).toBe(false);
  });
  it('rejects touches with .. (path traversal)', () => {
    const result = TaskSchema.safeParse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Test',
      touches: ['../etc/passwd'],
      checks: [{ id: 'scope', type: 'diff_scope', allow: ['../etc/passwd'] }],
    });
    expect(result.success).toBe(false);
  });
  it('rejects unknown top-level keys (.strict())', () => {
    const result = TaskSchema.safeParse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Test',
      touches: ['src/**'],
      checks: [{ id: 'scope', type: 'diff_scope', allow: ['src/**'] }],
      unexpected_field: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('DecisionSchema', () => {
  it('accepts valid decision', () => {
    const d = DecisionSchema.parse({
      baton_version: 1,
      id: 'D-0001',
      title: 'Test',
      key: 'area.thing',
      areas: ['src/**'],
      status: 'proposed',
      date: '2026-09-30',
    });
    expect(d.id).toBe('D-0001');
  });
  it('rejects invalid key (uppercase)', () => {
    const result = DecisionSchema.safeParse({
      baton_version: 1,
      id: 'D-0001',
      title: 'Test',
      key: 'Area.Thing',
      areas: ['src/**'],
      status: 'proposed',
      date: '2026-09-30',
    });
    expect(result.success).toBe(false);
  });
});

describe('ReportSchema — issue #4 (changed_files POSIX validation)', () => {
  it('accepts valid report with POSIX paths', () => {
    const r = ReportSchema.parse({
      baton_version: 1,
      task: 'T-0001',
      worker: 'claude',
      branch: 'baton/T-0001-test',
      base_commit: 'a1b2c3d',
      head_commit: 'e4f5a6b',
      claims: [],
      changed_files: ['src/api/handler.ts', 'test/api.test.ts'],
    });
    expect(r.changed_files).toHaveLength(2);
  });
  it('rejects absolute paths in changed_files', () => {
    const result = ReportSchema.safeParse({
      baton_version: 1,
      task: 'T-0001',
      worker: 'claude',
      branch: 'baton/T-0001-test',
      base_commit: 'a1b2c3d',
      head_commit: 'e4f5a6b',
      claims: [],
      changed_files: ['/etc/passwd'],
    });
    expect(result.success).toBe(false);
  });
  it('rejects paths with .. (traversal)', () => {
    const result = ReportSchema.safeParse({
      baton_version: 1,
      task: 'T-0001',
      worker: 'claude',
      branch: 'baton/T-0001-test',
      base_commit: 'a1b2c3d',
      head_commit: 'e4f5a6b',
      claims: [],
      changed_files: ['../secret.txt'],
    });
    expect(result.success).toBe(false);
  });
});

describe('Ledger event schemas (P0-2, P0-3, P0-4, P0-11)', () => {
  it('requires prior_status on blocked event (P0-2)', () => {
    const result = LedgerEventSchema.safeParse({
      v: 1, id: 'e-000001', ts: '2026-09-30T12:00:00Z',
      type: 'blocked',
      task: 'T-0001',
      // missing prior_status
      reason: 'waiting',
    });
    expect(result.success).toBe(false);
  });
  it('accepts blocked event with prior_status (P0-2)', () => {
    const result = LedgerEventSchema.safeParse({
      v: 1, id: 'e-000001', ts: '2026-09-30T12:00:00Z',
      type: 'blocked',
      task: 'T-0001',
      prior_status: 'in_review',
      reason: 'waiting',
    });
    expect(result.success).toBe(true);
  });
  it('requires hash on decision_status event (P0-3)', () => {
    const result = LedgerEventSchema.safeParse({
      v: 1, id: 'e-000001', ts: '2026-09-30T12:00:00Z',
      type: 'decision_status',
      decision: 'D-0001',
      from: 'proposed',
      to: 'accepted',
      // missing hash
    });
    expect(result.success).toBe(false);
  });
  it('requires base_commit on verify_run event (P0-4)', () => {
    const result = LedgerEventSchema.safeParse({
      v: 1, id: 'e-000001', ts: '2026-09-30T12:00:00Z',
      type: 'verify_run',
      run_id: 'r-0001',
      task: 'T-0001',
      // missing base_commit
      head_commit: 'abc123',
      verdict: 'all_pass',
    });
    expect(result.success).toBe(false);
  });
  it('accepts follow_up_task as optional string on rejected (P0-11)', () => {
    const result = LedgerEventSchema.safeParse({
      v: 1, id: 'e-000001', ts: '2026-09-30T12:00:00Z',
      type: 'rejected',
      task: 'T-0001',
      reason: 'scope creep',
      follow_up_task: 'T-0002',
    });
    expect(result.success).toBe(true);
  });
});
