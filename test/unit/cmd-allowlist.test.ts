// v1.3.2 P2: allowlist matching is token-exact, not prefix-of-string.
// Verified gaps: with allowlist ["node *","npm test *"], "nodemon x",
// "node_evil x" and "npm testing-x" were all ALLOWED because the check was
// `check.run.startsWith(entry minus " *")`.
// Also: task YAML may express `run` as an argv array so quoted arguments
// survive ("npm test -- -t \"a b\""); the string form stays for simple
// commands. shell stays false.
import { describe, it, expect } from 'vitest';
import { commandAllowed } from '../../src/core/check-engine.js';
import { CheckSchema, TaskSchema } from '../../src/core/schemas.js';

describe('commandAllowed token matching (v1.3.2 P2)', () => {
  const allow = ['node *', 'npm test *', 'git status'];

  it('allows exact-prefix token matches with wildcard', () => {
    expect(commandAllowed(['node', 'x'], allow)).toBe('node *');
    expect(commandAllowed(['npm', 'test', 'foo'], allow)).toBe('npm test *');
    expect(commandAllowed(['npm', 'test', '--', '-t', 'a b'], allow)).toBe('npm test *');
    // wildcard covers zero remaining args too
    expect(commandAllowed(['node'], allow)).toBe('node *');
  });

  it('DENIES prefix-string lookalikes (the v1.3.1 bug)', () => {
    expect(commandAllowed(['nodemon', 'x'], allow)).toBeNull();
    expect(commandAllowed(['node_evil', 'x'], allow)).toBeNull();
    expect(commandAllowed(['npm', 'testing-x'], allow)).toBeNull();
  });

  it('non-wildcard entries match the whole argv only', () => {
    expect(commandAllowed(['git', 'status'], allow)).toBe('git status');
    expect(commandAllowed(['git', 'status', '--short'], allow)).toBeNull();
  });

  it('empty allowlist allows nothing', () => {
    expect(commandAllowed(['node'], [])).toBeNull();
  });
});

describe('cmd run as argv array (v1.3.2 P2)', () => {
  it('parses an array run in a check schema', () => {
    const c = CheckSchema.parse({ id: 't', type: 'cmd', run: ['npm', 'test', '--', '-t', 'a b'] });
    expect(Array.isArray(c.run)).toBe(true);
    expect((c.run as string[]).length).toBe(5);
  });

  it('still accepts the string form', () => {
    const c = CheckSchema.parse({ id: 't', type: 'cmd', run: 'npm test' });
    expect(c.run).toBe('npm test');
  });

  it('rejects an empty array run', () => {
    expect(() => CheckSchema.parse({ id: 't', type: 'cmd', run: [] })).toThrow();
  });

  it('string form still rejects forbidden shell characters', () => {
    expect(() => TaskSchema.parse({ baton_version: 1, id: 'T-0001', title: 'x', touches: ['src/**'], checks: [{ id: 't', type: 'cmd', run: 'npm test; rm -rf /' }] })).toThrow();
  });

  it('array tokens pass through verbatim (spaces preserved, quotes not needed)', () => {
    const c = CheckSchema.parse({ id: 't', type: 'cmd', run: ['node', '-e', 'console.log("a b")'] });
    expect((c.run as string[])[2]).toBe('console.log("a b")');
  });

  it('task schema accepts a task with an array cmd run', () => {
    const t = TaskSchema.parse({
      baton_version: 1,
      id: 'T-0001',
      title: 'Array run',
      touches: ['src/**'],
      checks: [{ id: 'tests', type: 'cmd', run: ['npm', 'test', '--', '-t', 'a b'] }],
    });
    expect(Array.isArray(t.checks[0] && (t.checks[0] as { run: unknown }).run)).toBe(true);
  });
});
