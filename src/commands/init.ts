// baton init command. Spec §5.4. Idempotent.
// Creates folders, templates, .baton/policy.yml, pointer block, gitignore/gitattributes.
// P0-12: baton upgrade / migrate reserved (exit 4).
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
  STATE_TEMPLATE, CONSTRAINTS_TEMPLATE, DEFAULT_POLICY,
  GITIGNORE_LINES, GITATTRIBUTES_LINES, POINTER_BLOCK,
} from '../templates/index.js';
import { isGitRepo } from '../io/git.js';

const REQUIRED_DIRS = [
  'project-memory',
  'project-memory/decisions',
  'project-memory/tasks',
  'project-memory/reports',
  'project-memory/packets',
  'project-memory/sessions',
  '.baton',
  '.baton/runs',
];

const POINTER_FILES = ['AGENTS.md', 'CLAUDE.md'];

const START_MARKER = '<!-- baton:start -->';
const END_MARKER = '<!-- baton:end -->';

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function appendPointerBlock(filePath: string): Promise<'created' | 'appended' | 'updated'> {
  let content = '';
  if (await fileExists(filePath)) {
    content = await readFile(filePath, 'utf8');
    if (content.includes(START_MARKER) && content.includes(END_MARKER)) {
      // Replace existing block
      const startIdx = content.indexOf(START_MARKER);
      const endIdx = content.indexOf(END_MARKER) + END_MARKER.length;
      const updated = content.slice(0, startIdx) + POINTER_BLOCK + content.slice(endIdx);
      await writeFile(filePath, updated, 'utf8');
      return 'updated';
    }
    // Append at end with separator
    const sep = content.endsWith('\n') ? '\n' : '\n\n';
    const updated = content + sep + POINTER_BLOCK + '\n';
    await writeFile(filePath, updated, 'utf8');
    return 'appended';
  }
  await writeFile(filePath, POINTER_BLOCK + '\n', 'utf8');
  return 'created';
}

export interface InitResult {
  created: string[];
  skipped: string[];
  pointers: { file: string; action: 'created' | 'appended' | 'updated' }[];
  firstRun: boolean;
}

export async function init(repoRoot: string): Promise<InitResult> {
  // Spec §5.4: requires git repo (else exit 7)
  if (!(await isGitRepo(repoRoot))) {
    const err = new Error('not a git repository');
    (err as Error & { exitCode?: number }).exitCode = 7;
    throw err;
  }

  const created: string[] = [];
  const skipped: string[] = [];

  // Create directories
  for (const dir of REQUIRED_DIRS) {
    const full = path.join(repoRoot, dir);
    try {
      await mkdir(full, { recursive: true });
      // mkdir recursive doesn't tell us if it created or already existed. Check via stat.
      created.push(dir + '/');
    } catch {
      skipped.push(dir + '/');
    }
  }

  // Create STATE.md (never overwrite)
  const statePath = path.join(repoRoot, 'project-memory/STATE.md');
  if (!(await fileExists(statePath))) {
    await writeFile(statePath, STATE_TEMPLATE, 'utf8');
    created.push('project-memory/STATE.md');
  } else {
    skipped.push('project-memory/STATE.md');
  }

  // Create CONSTRAINTS.md (never overwrite)
  const constraintsPath = path.join(repoRoot, 'project-memory/CONSTRAINTS.md');
  if (!(await fileExists(constraintsPath))) {
    await writeFile(constraintsPath, CONSTRAINTS_TEMPLATE, 'utf8');
    created.push('project-memory/CONSTRAINTS.md');
  } else {
    skipped.push('project-memory/CONSTRAINTS.md');
  }

  // Create empty ledger.jsonl (never overwrite)
  const ledgerPath = path.join(repoRoot, 'project-memory/ledger.jsonl');
  if (!(await fileExists(ledgerPath))) {
    await writeFile(ledgerPath, '', 'utf8');
    created.push('project-memory/ledger.jsonl');
  } else {
    skipped.push('project-memory/ledger.jsonl');
  }

  // Create .baton/policy.yml (never overwrite)
  const policyPath = path.join(repoRoot, '.baton/policy.yml');
  if (!(await fileExists(policyPath))) {
    await writeFile(policyPath, DEFAULT_POLICY, 'utf8');
    created.push('.baton/policy.yml');
  } else {
    skipped.push('.baton/policy.yml');
  }

  // Update .gitignore (append lines that aren't already there)
  const gitignorePath = path.join(repoRoot, '.gitignore');
  let gitignoreContent = '';
  if (await fileExists(gitignorePath)) {
    gitignoreContent = await readFile(gitignorePath, 'utf8');
  }
  const newGitignoreLines = GITIGNORE_LINES.split('\n').filter(l => l.length > 0)
    .filter(l => !gitignoreContent.includes(l));
  if (newGitignoreLines.length > 0) {
    const sep = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    await writeFile(gitignorePath, gitignoreContent + sep + newGitignoreLines.join('\n') + '\n', 'utf8');
    created.push('.gitignore (appended ' + newGitignoreLines.length + ' lines)');
  } else {
    skipped.push('.gitignore');
  }

  // Update .gitattributes (append ledger.jsonl merge=union if missing)
  const gitattributesPath = path.join(repoRoot, '.gitattributes');
  let gitattributesContent = '';
  if (await fileExists(gitattributesPath)) {
    gitattributesContent = await readFile(gitattributesPath, 'utf8');
  }
  const newAttrLines = GITATTRIBUTES_LINES.split('\n').filter(l => l.length > 0)
    .filter(l => !gitattributesContent.includes(l));
  if (newAttrLines.length > 0) {
    const sep = gitattributesContent.length > 0 && !gitattributesContent.endsWith('\n') ? '\n' : '';
    await writeFile(gitattributesPath, gitattributesContent + sep + newAttrLines.join('\n') + '\n', 'utf8');
    created.push('.gitattributes (appended ' + newAttrLines.length + ' lines)');
  } else {
    skipped.push('.gitattributes');
  }

  // Write pointer blocks to AGENTS.md / CLAUDE.md
  const pointers: { file: string; action: 'created' | 'appended' | 'updated' }[] = [];
  for (const f of POINTER_FILES) {
    const action = await appendPointerBlock(path.join(repoRoot, f));
    pointers.push({ file: f, action });
  }

  // First-run detection: if STATE.md was newly created, show next-steps message
  const firstRun = created.includes('project-memory/STATE.md');

  return { created, skipped, pointers, firstRun };
}
