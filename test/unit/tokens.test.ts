import { describe, it, expect } from 'vitest';
import { BUDGET_DEFAULT, estimateTokens } from '../../src/core/tokens.js';

describe('BUDGET_DEFAULT', () => {
  it('is 6000', () => {
    expect(BUDGET_DEFAULT).toBe(6000);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('returns 2 for "hello" (ceil(5/4) = 2)', () => {
    expect(estimateTokens('hello')).toBe(2);
  });
  it('returns 2 for 8 chars', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});
