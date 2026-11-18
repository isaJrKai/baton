import { describe, it, expect } from 'vitest';
import { SECRET_PATTERNS, mask, scan } from '../../src/core/secrets.js';

describe('SECRET_PATTERNS', () => {
  it('has all 6 default patterns', () => {
    const names = SECRET_PATTERNS.map(p => p.name);
    expect(names).toContain('aws');
    expect(names).toContain('github');
    expect(names).toContain('slack');
    expect(names).toContain('stripe');
    expect(names).toContain('private_key');
    expect(names).toContain('generic');
    expect(names).toHaveLength(6);
  });
});

describe('mask', () => {
  it('returns first4+****+last4 for long strings', () => {
    expect(mask('sk_live_abc123def456')).toBe('sk_l****f456');
  });
  it('returns **** for short strings', () => {
    expect(mask('abc')).toBe('****');
  });
});

describe('scan', () => {
  it('finds AWS access key', () => {
    const findings = scan('AKIATESTTESTTEST1234');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.name).toBe('aws');
  });
  it('returns empty for clean text', () => {
    expect(scan('just a normal line of code')).toEqual([]);
  });
});
