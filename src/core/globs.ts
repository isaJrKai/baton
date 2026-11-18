import picomatch from 'picomatch';

/**
 * Convert Windows-style backslashes to forward slashes.
 * Pure function: no I/O, no side effects.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * picomatch wrapper. Always uses { dot: true } per D-0001.
 * Both path and glob are POSIX-normalized before matching.
 */
export function isMatch(path: string, glob: string): boolean {
  const posixPath = toPosix(path);
  const posixGlob = toPosix(glob);
  return picomatch(posixGlob, { dot: true })(posixPath);
}

// The static prefix of a glob is its leading path segments that contain
// NONE of the metacharacters: * ? [ ] { } ( ) !
// Returns '' as soon as a segment with a metacharacter is encountered
// (including the first segment).
//
// Examples:
//   'src/api/tasks/x' -> 'src/api/tasks'
//   'src/api/x'        -> 'src/api'
//   'x' (wildcard)     -> ''
//   'src'              -> 'src'
export function staticPrefix(glob: string): string {
  const segments = toPosix(glob).split('/').filter(s => s.length > 0);
  const result: string[] = [];
  for (const seg of segments) {
    if (/[*?[\]{}()!]/.test(seg)) break;
    result.push(seg);
  }
  return result.join('/');
}

/**
 * Two globs overlap if one's static prefix is a segment-wise prefix of the other.
 * An empty static prefix overlaps everything (per spec §3.5).
 */
export function overlaps(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === '' || pb === '') return true;
  if (pa === pb) return true;
  const paSegs = pa.split('/');
  const pbSegs = pb.split('/');
  const minLen = Math.min(paSegs.length, pbSegs.length);
  for (let i = 0; i < minLen; i++) {
    if (paSegs[i] !== pbSegs[i]) return false;
  }
  return true;
}

/**
 * Expand a glob into concrete file paths by checking a candidate list.
 * Used by staleness check to know which files a watch glob refers to.
 */
export function expandGlob(glob: string, candidates: string[]): string[] {
  const posixGlob = toPosix(glob);
  const matcher = picomatch(posixGlob, { dot: true });
  return candidates.filter(c => matcher(toPosix(c)));
}
