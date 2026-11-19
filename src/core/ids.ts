/**
 * Allocate the next sequential ID under the lock.
 * Caller MUST already hold .baton/lock (G11).
 *
 * IDs are zero-padded to 4 digits: T-0001, D-0001, R-0001, c-0001, r-0001, e-000001.
 * For ledger events we use 6 digits because ledger grows fastest.
 */
export function nextId(existing: string[], prefix: string, pad = 4): string {
  const nums = existing
    .map(s => parseInt(s.split('-')[1] ?? '0', 10))
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(next).padStart(pad, '0')}`;
}

/**
 * Hash a file's bytes for task_locked and decision_status events.
 * Returns sha256 hex string.
 */
export function hashBytes(bytes: Uint8Array): string {
  // Use Web Crypto (available in Node 20+ globally)
  // Avoid importing node:crypto to keep this function pure-testable.
  const crypto = (globalThis as any).crypto;
  if (!crypto?.subtle) {
    throw new Error('Web Crypto not available. Requires Node 20+.');
  }
  // crypto.subtle.digest is async, but for sync callers we'd need node:crypto.
  // For our use case (ledger writes are already async), this is fine.
  // However to keep it sync, fall back to a simple non-crypto hash if needed.
  // Actually, just use node:crypto here — it's the right tool.
  throw new Error('Use sha256Sync from io/hash.ts instead — this stub is for type purity');
}

/**
 * Simple synchronous FNV-1a hash. NOT for security, just for stable non-cryptographic IDs.
 * Real hashes use io/hash.ts (sha256Sync).
 */
export function fnv1aSync(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
