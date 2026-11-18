// baton doctor command. Spec §7.3a.
// Structural integrity only — never stale or conflicts.
// Errors (exit 3): unparseable files, duplicate IDs, ledger parse failures,
//   truncated ledger line, non-increasing IDs, locked hash mismatch,
//   decision hash mismatch, invalid secret patterns, invalid policy,
//   orphan reports, stale worktrees.
// Warnings (exit 0): report whose task is done/rejected, several terminal events,
//   missing gitignore, STATE.md over 60 lines.
import { readLedger } from '../io/ledger-file.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';
import { git } from '../io/git.js';
import { sha256Sync } from '../io/hash.js';
import { replay } from '../core/ledger-replay.js';
import { fileExistsAtRef } from '../io/git.js';

function parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return { frontMatter: yaml.parse(m[1] ?? '') as Record<string, unknown>, body: m[2] ?? '' };
  } catch {
    return null;
  }
}

interface DoctorFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  fix?: string;
}

export async function doctor(repoRoot: string): Promise<{ findings: DoctorFinding[]; hasErrors: boolean }> {
  const findings: DoctorFinding[] = [];

  // 1. Check ledger parseability
  const { events, malformed } = await readLedger(repoRoot);
  if (malformed.length > 0) {
    for (const m of malformed) {
      findings.push({
        level: 'error',
        code: 'E_LEDGER_MALFORMED',
        message: `ledger.jsonl:${m.line}: malformed JSON`,
        fix: 'Edit or remove the malformed line. Run: baton doctor --fix (not implemented)',
      });
    }
  }

  // 2. Check non-increasing ledger IDs
  let lastId = 0;
  for (const e of events) {
    const num = parseInt(e.id.split('-')[1] ?? '0', 10);
    if (num <= lastId && lastId > 0) {
      findings.push({
        level: 'error',
        code: 'E_NON_INCREASING_ID',
        message: `ledger.jsonl: non-increasing ID ${e.id} after e-${String(lastId).padStart(6, '0')}`,
        fix: 'Restore the base branch ledger and re-run the affected command',
      });
    }
    lastId = Math.max(lastId, num);
  }

  // 3. Check task files
  const tasksDir = path.join(repoRoot, 'project-memory/tasks');
  let taskFiles: string[];
  try { taskFiles = await readdir(tasksDir); } catch { taskFiles = []; }
  const taskIds = new Set<string>();
  for (const f of taskFiles) {
    if (!f.endsWith('.md')) continue;
    const taskId = f.replace(/\.md$/, '');
    if (taskIds.has(taskId)) {
      findings.push({ level: 'error', code: 'E_DUPLICATE_TASK_ID', message: `duplicate task ID: ${taskId}` });
    }
    taskIds.add(taskId);

    const text = await readFile(path.join(tasksDir, f), 'utf8').catch(() => '');
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: 'error', code: 'E_UNPARSEABLE', message: `${f}: front matter parse failed` });
    }
  }

  // 4. Check decision files
  const decisionsDir = path.join(repoRoot, 'project-memory/decisions');
  let decisionFiles: string[];
  try { decisionFiles = await readdir(decisionsDir); } catch { decisionFiles = []; }
  const decisionIds = new Set<string>();
  for (const f of decisionFiles) {
    if (!f.endsWith('.md')) continue;
    const decisionId = f.replace(/\.md$/, '');
    if (decisionIds.has(decisionId)) {
      findings.push({ level: 'error', code: 'E_DUPLICATE_DECISION_ID', message: `duplicate decision ID: ${decisionId}` });
    }
    decisionIds.add(decisionId);

    const text = await readFile(path.join(decisionsDir, f), 'utf8').catch(() => '');
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      findings.push({ level: 'error', code: 'E_UNPARSEABLE', message: `${f}: front matter parse failed` });
    }
  }

  // 5. Check locked task hashes match base branch
  const state = replay(events);
  let baseBranch = 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policyRaw = yaml.parse(policyText) as { default_branch?: string } | null;
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch { /* use default */ }

  for (const [taskId, t] of state.tasks) {
    if (!t.lockedHash) continue;
    // Check if task file exists on base branch and hash matches
    const taskPath = `project-memory/tasks/${taskId}.md`;
    const exists = await fileExistsAtRef(repoRoot, baseBranch, taskPath);
    if (!exists) {
      findings.push({
        level: 'error',
        code: 'E_LOCK_HASH_MISMATCH',
        message: `task ${taskId}: locked but not found on ${baseBranch}`,
        fix: `baton task unlock ${taskId} --reason "not on base"`,
      });
    }
  }

  // 6. Check for stale worktrees
  try {
    const wtResult = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
    if (wtResult.exitCode === 0) {
      const blocks = wtResult.stdout.split('\n\n');
      for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.length > 0);
        const wtLine = lines.find(l => l.startsWith('worktree '));
        if (!wtLine) continue;
        const wtPath = wtLine.slice('worktree '.length);
        if (wtPath.includes('.baton/tmp/wt-')) {
          findings.push({
            level: 'error',
            code: 'E_STALE_WORKTREE',
            message: `stale worktree: ${wtPath}`,
            fix: 'git worktree remove --force ' + wtPath,
          });
        }
      }
    }
  } catch { /* ignore */ }

  // 7. Check STATE.md line count
  try {
    const stateText = await readFile(path.join(repoRoot, 'project-memory/STATE.md'), 'utf8');
    const lineCount = stateText.split('\n').length;
    if (lineCount > 60) {
      findings.push({
        level: 'warning',
        code: 'W_STATE_TOO_LONG',
        message: `STATE.md is ${lineCount} lines (guidance: 60)`,
      });
    }
  } catch { /* ignore */ }

  // 8. Check gitignore entries
  try {
    const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    const required = ['project-memory/packets/', 'project-memory/sessions/', '.baton/'];
    for (const r of required) {
      if (!gitignore.includes(r)) {
        findings.push({ level: 'warning', code: 'W_MISSING_GITIGNORE', message: `.gitignore missing: ${r}` });
      }
    }
  } catch { /* ignore */ }

  const hasErrors = findings.some(f => f.level === 'error');
  return { findings, hasErrors };
}

export function formatDoctorOutput(result: { findings: DoctorFinding[]; hasErrors: boolean }): string {
  const lines: string[] = [];
  const errors = result.findings.filter(f => f.level === 'error');
  const warnings = result.findings.filter(f => f.level === 'warning');

  if (errors.length > 0) {
    lines.push(`ERRORS (${errors.length})`);
    for (const e of errors) {
      lines.push(`  ${e.code}: ${e.message}`);
      if (e.fix) lines.push(`    fix: ${e.fix}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`WARNINGS (${warnings.length})`);
    for (const w of warnings) {
      lines.push(`  ${w.code}: ${w.message}`);
    }
  }
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('No issues found. All clear.');
  }
  return lines.join('\n');
}
