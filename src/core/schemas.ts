// Zod schemas for Baton file formats. v1.1.1 conformance.
// P0-1: Check has optional `description` field on every variant.

import { z } from 'zod';

// ---------- Check (P0-1: description field added) ----------
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('cmd'),
    run: z.string().min(1),
    covers: z.array(z.string()).optional(),
    watch: z.array(z.string()).optional(),
  }),
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('diff_scope'),
    allow: z.array(z.string()).min(1),
  }),
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('grep'),
    file: z.string(),
    pattern: z.string(),
    mode: z.enum(['must_match', 'must_not_match']).default('must_match'),
    covers: z.array(z.string()).optional(),
    watch: z.array(z.string()).optional(),
  }),
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('file_exists'),
    path: z.string(),
    exists: z.boolean().default(true),
    covers: z.array(z.string()).optional(),
    watch: z.array(z.string()).optional(),
  }),
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('contract'),
    file: z.string(),
    expect: z.enum(['changed', 'unchanged', 'either']).default('either'),
    covers: z.array(z.string()).optional(),
    watch: z.array(z.string()).optional(),
  }),
  z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(120).optional(),
    type: z.literal('no_secrets'),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

// ---------- Task ----------
export const TaskSchema = z.object({
  baton_version: z.literal(1),
  id: z.string().regex(/^T-\d{4}$/),
  title: z.string().min(1).max(120),
  base: z.string().optional(),
  depends_on: z.array(z.string().regex(/^T-\d{4}$/)).optional(),
  touches: z.array(z.string()).min(1),
  reads: z.array(z.string()).optional(),
  decisions: z.array(z.string().regex(/^D-\d{4}$/)).optional(),
  non_goals: z.array(z.string()).optional(),
  // v1.3.1: set on the task when the worker is explicitly allowed to edit
  // protected paths (e.g. the task legitimately updates tests). Written by
  // `baton task new --allow-protected`; verified as part of the locked hash.
  allow_protected: z.boolean().optional(),
  checks: z.array(CheckSchema).min(1),
}).strict().superRefine((t, ctx) => {
  // G9 + spec §3.5: touches must be POSIX repo-relative, no .., no leading / or ./
  for (const g of t.touches) {
    if (g.startsWith('/') || g.startsWith('./') || g.includes('..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `touches must be POSIX repo-relative without .. or leading / or ./: ${g}`,
        path: ['touches'],
      });
    }
    if (g.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `touches must use / not \\: ${g}`,
        path: ['touches'],
      });
    }
  }
  // Forbidden chars in cmd run strings (spec §3.3 policy)
  for (const c of t.checks) {
    if (c.type === 'cmd') {
      if (/[;&|<>`$()\n]/.test(c.run)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cmd run contains forbidden characters: ${c.run}`,
          path: ['checks'],
        });
      }
    }
  }
});
export type Task = z.infer<typeof TaskSchema>;

// ---------- Decision ----------
export const DecisionSchema = z.object({
  baton_version: z.literal(1),
  id: z.string().regex(/^D-\d{4}$/),
  title: z.string().min(1).max(120),
  key: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_-]+)*$/),
  areas: z.array(z.string()).min(1),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  supersedes: z.string().regex(/^D-\d{4}$/).optional(),
}).strict();
export type Decision = z.infer<typeof DecisionSchema>;

// ---------- Report ----------
// Issue #4 from reviewer: changed_files must be POSIX repo-relative without .. or \
const posixPath = z.string().refine(
  (p) => !p.startsWith('/') && !p.startsWith('./') && !p.includes('..') && !p.includes('\\'),
  { message: 'path must be POSIX repo-relative without .. or backslash' }
);

export const ReportSchema = z.object({
  baton_version: z.literal(1),
  task: z.string().regex(/^T-\d{4}$/),
  worker: z.string().min(1),
  branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/),
  base_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  head_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  claims: z.array(z.object({
    statement: z.string().min(1),
    key: z.string().optional(),
    evidence: z.string().optional(),
  })),
  changed_files: z.array(posixPath),
  not_done: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  decisions_proposed: z.array(z.string()).optional(),
}).strict();
export type Report = z.infer<typeof ReportSchema>;

// ---------- Policy ----------
export const PolicySchema = z.object({
  baton_version: z.literal(1),
  default_branch: z.string().default('main'),
  token_budget: z.number().int().positive().default(6000),
  execution: z.object({
    mode: z.enum(['local', 'docker']).default('local'),
    acknowledged: z.boolean().default(false),
    timeout_seconds: z.number().int().positive().default(300),
    docker_image: z.string().default(''),
  }).default({}),
  allowed_commands: z.array(z.string()).default([]),
  env_passthrough: z.array(z.string()).default([]),
  // P0-14: extended never_include defaults
  never_include: z.array(z.string()).default([
    '.env*',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/id_*',
    '**/secrets/**',
    '**/.npmrc',
    '**/.pypirc',
    '**/.netrc',
    '**/.aws/credentials',
    '**/.aws/config',
  ]),
  extra_secret_patterns: z.array(z.object({
    name: z.string(),
    regex: z.string(),
  })).default([]),
  // v1.3: retrieved-context tier size in packets. 0 disables the tier.
  retrieval_snippets: z.number().int().min(0).max(20).default(6),
  // v1.3.1: files the worker is judged by. If a worker edits these and the task
  // does not set allow_protected, verify restores the merge-base versions before
  // running checks and fails a protected_paths row. Set [] to disable.
  protected_paths: z.array(z.string()).default([
    'test/**',
    'tests/**',
    '**/*.test.*',
    '**/*.spec.*',
  ]),
}).strict();
export type Policy = z.infer<typeof PolicySchema>;

// ---------- Ledger events (P0-2, P0-3, P0-4, P0-11) ----------
const baseEvent = z.object({
  v: z.literal(1),
  id: z.string().regex(/^e-\d{6}$/),
  ts: z.string(),
});

export const LedgerEventSchema = z.discriminatedUnion('type', [
  baseEvent.extend({
    type: z.literal('task_locked'),
    task: z.string().regex(/^T-\d{4}$/),
    hash: z.string(),
    base_commit: z.string(),
  }),
  baseEvent.extend({
    type: z.literal('task_unlocked'),
    task: z.string().regex(/^T-\d{4}$/),
    reason: z.string(),
  }),
  baseEvent.extend({
    type: z.literal('packet_issued'),
    task: z.string().regex(/^T-\d{4}$/),
    packet_sha256: z.string(),
    budget: z.number(),
    omitted: z.array(z.string()),
  }),
  baseEvent.extend({
    type: z.literal('report_checked'),
    task: z.string().regex(/^T-\d{4}$/),
    report_sha256: z.string(),
    missing_in_report: z.array(z.string()),
    extra_in_report: z.array(z.string()),
    head_matches_branch: z.boolean(),
  }),
  baseEvent.extend({
    type: z.literal('claim'),
    claim_id: z.string().regex(/^c-\d{4}$/),
    task: z.string().regex(/^T-\d{4}$/),
    statement: z.string(),
    key: z.string().optional(),
    report_sha256: z.string(),
  }),
  baseEvent.extend({
    type: z.literal('verify_run'),
    run_id: z.string().regex(/^r-\d{4}$/),
    task: z.string().regex(/^T-\d{4}$/),
    base_commit: z.string(),   // P0-4
    head_commit: z.string(),
    verdict: z.enum(['all_pass', 'has_failures', 'incomplete']),
  }),
  baseEvent.extend({
    type: z.literal('check_result'),
    run_id: z.string().regex(/^r-\d{4}$/),
    task: z.string().regex(/^T-\d{4}$/),
    check: z.string(),
    result: z.enum(['pass', 'fail', 'skip']),
    reason: z.string().optional(),
    anchor: z.object({
      commit: z.string(),
      watch: z.array(z.string()),
    }).optional(),
    log: z.object({
      path: z.string(),
      sha256: z.string(),
    }).optional(),
  }),
  baseEvent.extend({
    type: z.literal('claim_status'),
    claim_id: z.string().regex(/^c-\d{4}$/),
    status: z.enum(['verified', 'failed', 'stale']),
    anchor: z.object({
      commit: z.string(),
      watch: z.array(z.string()),
    }).optional(),
    reason: z.string(),
    run_id: z.string().regex(/^r-\d{4}$/).optional(),  // P0-6: includes run_id
  }),
  baseEvent.extend({
    type: z.literal('accepted'),
    task: z.string().regex(/^T-\d{4}$/),
    commit: z.string(),
    override: z.string().nullable().optional(),
  }),
  baseEvent.extend({
    type: z.literal('rejected'),
    task: z.string().regex(/^T-\d{4}$/),
    reason: z.string(),
    follow_up_task: z.string().regex(/^T-\d{4}$/).optional(),   // P0-11: was boolean
  }),
  baseEvent.extend({
    // P0-2: prior_status recorded on blocked event
    type: z.literal('blocked'),
    task: z.string().regex(/^T-\d{4}$/),
    prior_status: z.string(),
    reason: z.string(),
  }),
  baseEvent.extend({
    type: z.literal('unblocked'),
    task: z.string().regex(/^T-\d{4}$/),
    reason: z.string(),
  }),
  baseEvent.extend({
    // P0-3: hash field added
    type: z.literal('decision_status'),
    decision: z.string().regex(/^D-\d{4}$/),
    from: z.string(),
    to: z.string(),
    hash: z.string(),
  }),
  baseEvent.extend({
    type: z.literal('conflict_ack'),
    key: z.string(),
    note: z.string(),
  }),
  baseEvent.extend({
    // v1.3 orchestrator: a task rejected N times (N >= 2) is escalated for human review.
    // Written automatically by `baton reject` when this is the second (or later) rejection.
    type: z.literal('escalated'),
    task: z.string().regex(/^T-\d{4}$/),
    rejections: z.number().int().min(2),
    reason: z.string(),
  }),
  // v1.3 orchestrator primitives: area leases. A lease claims exclusive
  // dispatch rights over a task's touches areas for a TTL. Overlap is checked
  // by the lease command at take-time; replay recomputes expiry from ts.
  baseEvent.extend({
    type: z.literal('lease_acquired'),
    task: z.string().regex(/^T-\d{4}$/),
    worker: z.string().min(1),
    areas: z.array(z.string()).min(1),
    ttl_minutes: z.number().int().positive(),
  }),
  baseEvent.extend({
    type: z.literal('lease_released'),
    task: z.string().regex(/^T-\d{4}$/),
    reason: z.string(),
  }),
  baseEvent.extend({
    // v1.3.1: written by `baton doctor --fix` after a union merge of two
    // branches that both appended ledger events. Records what was repaired.
    type: z.literal('ledger_repaired'),
    renumbered_events: z.number().int().min(0),
    remapped_claims: z.number().int().min(0),
    remapped_runs: z.number().int().min(0),
    reason: z.string(),
  }),
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
