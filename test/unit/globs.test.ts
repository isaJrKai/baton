import { describe, it, expect } from 'vitest';
import { toPosix, isMatch, staticPrefix, overlaps } from '../../src/core/globs.js';

describe('toPosix', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
  });
  it('leaves forward slashes unchanged', () => {
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });
});

describe('isMatch', () => {
  it('matches simple glob', () => {
    expect(isMatch('src/api/handler.ts', 'src/**/*.ts')).toBe(true);
  });
  it('matches dotfiles with dot:true', () => {
    expect(isMatch('.env', '**/.env*')).toBe(true);
  });
});

describe('staticPrefix', () => {
  it('extracts leading non-metachar segments', () => {
    expect(staticPrefix('src/api/tasks/**')).toBe('src/api/tasks');
  });
  it('returns empty for first-segment metachar', () => {
    expect(staticPrefix('**/*.ts')).toBe('');
  });
});

describe('overlaps', () => {
  it('returns true for nested prefixes', () => {
    expect(overlaps('src/api/**', 'src/**')).toBe(true);
  });
  it('returns true when either prefix is empty', () => {
    expect(overlaps('**/*.ts', 'src/api/**')).toBe(true);
  });
  it('returns false for non-overlapping', () => {
    expect(overlaps('src/**', 'test/**')).toBe(false);
  });
});
