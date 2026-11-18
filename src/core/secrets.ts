// Secret scanner. Per spec Appendix B + policy extra_secret_patterns.
// Masking: first4 + "****" + last4 for strings >= 8 chars; "****" for shorter.
// Better than v1.0's first-4-then-ellipsis per reviewer §8.3.

export type SecretPattern = { name: string; regex: RegExp };

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'aws',         regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'github',      regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'slack',       regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe',      regex: /sk_live_[A-Za-z0-9]{16,}/g },
  { name: 'private_key', regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'generic',     regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/gi },
];

export function mask(value: string): string {
  if (value.length < 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export type Finding = { line: number; masked: string; name: string };

/**
 * Scan each line of text against all default + extra patterns.
 * Returns an array of findings with masked values (never full secrets).
 */
export function scan(
  text: string,
  extra: { name: string; regex: string }[] = []
): Finding[] {
  const all: SecretPattern[] = [...SECRET_PATTERNS];
  for (const e of extra) {
    try {
      all.push({ name: e.name, regex: new RegExp(e.regex, 'g') });
    } catch {
      // Invalid regex — skip silently, doctor will catch separately
    }
  }
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const p of all) {
      p.regex.lastIndex = 0;
      const m = line.match(p.regex);
      if (m && m.length > 0) {
        for (const match of m) {
          findings.push({ line: i + 1, masked: mask(match), name: p.name });
        }
      }
    }
  }
  return findings;
}
