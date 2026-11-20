// Secret scanner. Per spec Appendix B + policy extra_secret_patterns.
// Masking: first4 + "****" + last4 for strings >= 8 chars; "****" for shorter.
// Better than v1.0's first-4-then-ellipsis per reviewer §8.3.
//
// v1.3.2 (P1): real-world credential shapes that the original six patterns
// missed, confirmed by an independent review probing scan() directly:
//   - connection URLs with embedded credentials (postgres/mysql/etc, quoted
//     or unquoted, Neon/Supabase style)
//   - OpenAI / Anthropic style keys (sk-proj-, sk-ant-, sk-...)
//   - Google API keys (AIza...)
//   - JWTs (Supabase service tokens)
//   - unquoted .env-style assignments (password = hunter2...)
// Obvious placeholders (example, changeme, your_, xxxx, <...>) are skipped to
// limit false positives on example/template files.

export type SecretPattern = { name: string; regex: RegExp };

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'aws',             regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'github',          regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'slack',           regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe',          regex: /sk_live_[A-Za-z0-9]{16,}/g },
  // v1.3.2: sk- prefixed keys (OpenAI sk-proj-…, Anthropic sk-ant-…). Does not
  // collide with stripe's sk_live_ (underscore, not hyphen).
  { name: 'openai_style',    regex: /sk-[A-Za-z0-9_-]{20,}/g },
  // v1.3.2: Google API keys are exactly AIza + 35 chars.
  { name: 'google_api_key',  regex: /AIza[0-9A-Za-z_-]{35}/g },
  // v1.3.2: JWT — two base64url segments starting eyJ (header.payload) plus a
  // signature segment of at least 10 chars.
  { name: 'jwt',             regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}/g },
  // v1.3.2: any scheme://user:password@ URL (postgresql, mysql, redis, ...).
  // Password must be 6+ chars without whitespace or @ or /.
  { name: 'url_credentials', regex: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{6,}@/g },
  // v1.3.2: unquoted .env-style assignment of a secret-looking variable.
  // Case-insensitive so `password = hunter2…` is caught too. Requires a value
  // of 12+ non-space chars to avoid tripping on short config values.
  { name: 'env_assignment',  regex: /^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*\S{12,}/gi },
  { name: 'private_key',     regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'generic',         regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/gi },
];

/**
 * v1.3.2: obvious placeholder values that must not fail no_secrets.
 * Applied per match, not per line, so a line containing both a placeholder and
 * a real credential still reports the real one.
 */
export function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower.includes('example') ||
    lower.includes('changeme') ||
    lower.includes('your_') ||
    lower.includes('xxxx')
  ) return true;
  // Angle-bracket template placeholders: <your-api-key-here>, <PASSWORD>, ...
  if (/<[^>]{0,60}>/.test(value)) return true;
  return false;
}

export function mask(value: string): string {
  if (value.length < 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export type Finding = { line: number; masked: string; name: string };

/**
 * Scan each line of text against all default + extra patterns.
 * Returns an array of findings with masked values (never full secrets).
 * Matches that look like placeholders (isPlaceholder) are skipped.
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
          if (isPlaceholder(match)) continue;  // v1.3.2: skip placeholders
          findings.push({ line: i + 1, masked: mask(match), name: p.name });
        }
      }
    }
  }
  return findings;
}
