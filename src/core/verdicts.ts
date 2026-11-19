// Check strength classification. P0-13.
// cmd (behavior) > contract (interface) > grep/file_exists (artifact) > diff_scope/no_secrets (hygiene)
// Used by task ready warning, verify verdict table, baton status counts.

export type Strength = 'behavior' | 'interface' | 'artifact' | 'hygiene';

export function strengthOf(type: string): Strength {
  switch (type) {
    case 'cmd':          return 'behavior';
    case 'contract':     return 'interface';
    case 'grep':
    case 'file_exists':  return 'artifact';
    case 'diff_scope':
    case 'no_secrets':
    case 'protected_paths': return 'hygiene';
    default:             return 'hygiene';
  }
}

export type Verdict = 'all_pass' | 'has_failures' | 'incomplete';

export function verdict(results: { result: 'pass' | 'fail' | 'skip' }[]): Verdict {
  if (results.some(r => r.result === 'fail')) return 'has_failures';
  if (results.some(r => r.result === 'skip')) return 'incomplete';
  return 'all_pass';
}
