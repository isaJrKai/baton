// Lock file implementation. G11 + P0-8.
// O_EXCL create + retry with backoff. Held across read-write-fsync transaction.
// Re-entrant within same process: same-process same-root re-acquisition is a no-op.
// This avoids deadlock when a command (e.g., decideNew) holds the lock and then
// calls appendLedger which also tries to acquire.
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE = 'lock';
const heldLocks = new Set<string>();

/**
 * Acquire .baton/lock. Retries with exponential backoff up to ~2s.
 * Re-entrant: if this process already holds the lock for this repoRoot,
 * returns immediately. Caller MUST call unlock() in a finally block.
 */
export async function lock(repoRoot: string): Promise<void> {
  const lockKey = path.resolve(repoRoot);
  if (heldLocks.has(lockKey)) return;
  const lockPath = path.join(repoRoot, '.baton', LOCK_FILE);
  for (let i = 0; i < 50; i++) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      heldLocks.add(lockKey);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      await new Promise(r => setTimeout(r, Math.min(40 * (i + 1), 2000)));
    }
  }
  throw new Error(`could not acquire .baton/lock after 50 attempts (file: ${lockPath})`);
}

/**
 * Release .baton/lock. Only unlinks if this process is the holder.
 */
export async function unlock(repoRoot: string): Promise<void> {
  const lockKey = path.resolve(repoRoot);
  if (!heldLocks.has(lockKey)) return;
  heldLocks.delete(lockKey);
  const lockPath = path.join(repoRoot, '.baton', LOCK_FILE);
  try {
    await unlink(lockPath);
  } catch {
    // Already removed — fine
  }
}

/**
 * Run a function while holding the lock. Always releases in finally.
 */
export async function withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  await lock(repoRoot);
  try {
    return await fn();
  } finally {
    await unlock(repoRoot);
  }
}
