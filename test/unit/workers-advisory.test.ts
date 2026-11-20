// v1.3.2 P3: worker reputation output must be labeled advisory — the worker
// name comes from self-declared report front matter, not from the lease or the
// ledger writer, so a worker could claim a friendlier name.
import { describe, it, expect } from 'vitest';
import { formatWorkersOutput, type WorkerReputation } from '../../src/commands/workers.js';

describe('formatWorkersOutput advisory label (v1.3.2 P3)', () => {
  it('labels the table as advisory when there are workers', () => {
    const list: WorkerReputation[] = [
      { worker: 'glm-5', accepted: 2, rejected: 0, verifyFailures: 0, score: 20, tasks: ['T-0001', 'T-0002'] },
    ];
    const out = formatWorkersOutput(list);
    expect(out).toContain('ADVISORY');
    expect(out).toContain('self-declared');
    expect(out).toContain('glm-5');
  });

  it('empty table keeps its own explanation', () => {
    const out = formatWorkersOutput([]);
    expect(out).toContain('No worker reputation yet');
  });
});
