// SHA-256 hashing. Used for task_locked and decision_status events.
// Uses node:crypto (allowed — not in G24 deny list).
import { createHash } from 'node:crypto';

export function sha256Sync(bytes: Uint8Array | string): string {
  const input = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return createHash('sha256').update(input).digest('hex');
}
