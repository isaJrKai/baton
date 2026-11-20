import { describe, it, expect } from 'vitest';
import { SECRET_PATTERNS, mask, scan, isPlaceholder } from '../../src/core/secrets.js';

describe('SECRET_PATTERNS', () => {
  it('has the original 6 default patterns', () => {
    const names = SECRET_PATTERNS.map(p => p.name);
    expect(names).toContain('aws');
    expect(names).toContain('github');
    expect(names).toContain('slack');
    expect(names).toContain('stripe');
    expect(names).toContain('private_key');
    expect(names).toContain('generic');
  });
  // v1.3.2: real-world credential shapes the old scanner missed
  it('has the v1.3.2 patterns', () => {
    const names = SECRET_PATTERNS.map(p => p.name);
    expect(names).toContain('url_credentials');
    expect(names).toContain('openai_style');
    expect(names).toContain('google_api_key');
    expect(names).toContain('jwt');
    expect(names).toContain('env_assignment');
    expect(names).toHaveLength(11);
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

// v1.3.2 P1: verified-missed real-world credentials. Every sample below was
// confirmed to slip past the v1.3.1 scanner; each must now be CAUGHT.
describe('scan catches real-world credentials (v1.3.2)', () => {
  it('catches DATABASE_URL with embedded credentials (unquoted)', () => {
    const findings = scan('DATABASE_URL=postgresql://app_user:Zx9kQ2mLpR7vTn4Wb8@ep-x.neon.tech/db');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'url_credentials')).toBe(true);
  });
  it('catches quoted / Supabase-style connection strings', () => {
    const findings = scan('DATABASE_URL="postgresql://postgres:sup3rs3cretPw9@db.ref.supabase.co:5432/postgres"');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'url_credentials')).toBe(true);
  });
  it('catches mysql:// URLs with credentials too', () => {
    expect(scan('DATABASE_URL=mysql://root:s3curePassw0rd@127.0.0.1/app').length).toBeGreaterThan(0);
  });
  it('catches OpenAI project keys', () => {
    const findings = scan('OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'openai_style')).toBe(true);
  });
  it('catches Anthropic keys (sk-ant-)', () => {
    const findings = scan('ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'openai_style')).toBe(true);
  });
  it('catches Google API keys (AIza...)', () => {
    const findings = scan('GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'google_api_key')).toBe(true);
  });
  it('catches JWTs (Supabase service tokens)', () => {
    const findings = scan('SUPABASE_SERVICE_JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'jwt')).toBe(true);
  });
  it('catches unquoted uppercase .env-style assignments', () => {
    const findings = scan('DB_PASSWORD=hunter2hunter2hunter2');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'env_assignment')).toBe(true);
  });
  it('catches unquoted lowercase password assignments', () => {
    const findings = scan('password = hunter2hunter2hunter2');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(f => f.name === 'env_assignment')).toBe(true);
  });
  it('catches unquoted secret assignments', () => {
    expect(scan('SECRET_TOKEN = s3cr3t_value_123456').length).toBeGreaterThan(0);
    expect(scan('auth_token=my_long_secret_value').length).toBeGreaterThan(0);
  });
  it('reports correct line numbers', () => {
    const text = ['const a = 1;', 'DATABASE_URL=postgresql://app_user:Zx9kQ2mLpR7vTn4Wb8@ep-x.neon.tech/db', 'const b = 2;'].join('\n');
    const findings = scan(text);
    expect(findings.every(f => f.line === 2)).toBe(true);
  });
});

// Placeholders must not fail checks — limits false positives on example files.
describe('scan passes obvious placeholders (v1.3.2)', () => {
  it('unquoted assignments with example values', () => {
    expect(scan('API_KEY=example_key_value_here')).toEqual([]);
  });
  it('changeme values', () => {
    expect(scan('DB_PASSWORD=changeme_please_ok')).toEqual([]);
  });
  it('your_ prefixed values', () => {
    expect(scan('AUTH_TOKEN=your_token_goes_here')).toEqual([]);
  });
  it('xxxx masked values', () => {
    expect(scan('SECRET_KEY=xxxxxxxxxxxxxxxx')).toEqual([]);
  });
  it('angle-bracket placeholders', () => {
    expect(scan('API_KEY=<your-api-key-here>')).toEqual([]);
  });
  it('quoted placeholder strings (generic pattern)', () => {
    expect(scan('API_KEY="example_secret_value"')).toEqual([]);
    expect(scan('password = "changeme_password_ok"')).toEqual([]);
  });
  it('placeholder logic is exported and directly testable', () => {
    expect(isPlaceholder('example')).toBe(true);
    expect(isPlaceholder('changeme')).toBe(true);
    expect(isPlaceholder('your_key_here')).toBe(true);
    expect(isPlaceholder('xxxxxxxx')).toBe(true);
    expect(isPlaceholder('<your-key>')).toBe(true);
    expect(isPlaceholder('Zx9kQ2mLpR7vTn4Wb8')).toBe(false);
  });
  it('does NOT let the placeholder skip hide a real key', () => {
    const findings = scan('OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('scan (existing behavior preserved)', () => {
  it('finds AWS access key', () => {
    // Assembled from parts so no committed literal matches the AWS key shape.
    // (A previous revision scanned a redacted placeholder that contained no
    // key at all — vacuous. Amazon's documented example key ends in a word
    // that trips the placeholder skip, so this uses a neutral sample instead.)
    const awsExample = ['AK', 'IA', 'Q3T2W8R5Y6U7I9O1P'].join('');
    const findings = scan('aws_access_key_id = ' + awsExample);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.name === 'aws')).toBe(true);
  });
  it('returns empty for clean text', () => {
    expect(scan('just a normal line of code')).toEqual([]);
  });
  it('supports extra policy patterns', () => {
    const findings = scan('company_token: abc_1234567890', [
      { name: 'corp', regex: 'company_token: [a-z_0-9]+' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.name).toBe('corp');
  });
});
