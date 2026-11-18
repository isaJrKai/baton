// baton status --html command. Spec §8.3-§8.5.
// Single static HTML file with inline CSS. No JavaScript, no frameworks.
// CSP: default-src 'none'; style-src 'unsafe-inline'.
// Every dynamic string is HTML-escaped. Never render Markdown from claims/reports.
// Text labels alongside color. WCAG AA contrast. Print stylesheet. lang="en".
// Deterministic output (G30). Warn if > 5 MB.
import { readLedger } from '../io/ledger-file.js';
import { replay } from '../core/ledger-replay.js';
import { getCommitSha } from '../io/git.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'yaml';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const STYLES = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a1a; line-height: 1.6; max-width: 960px; margin: 0 auto; padding: 20px; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
h2 { font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.5rem; border-bottom: 2px solid #dee2e6; padding-bottom: 0.25rem; }
h3 { font-size: 1rem; margin-top: 1rem; margin-bottom: 0.25rem; }
.meta { color: #6c757d; font-size: 0.875rem; margin-bottom: 1rem; }
.section { background: #fff; border: 1px solid #dee2e6; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
.needs-attention { border-left: 4px solid #dc3545; }
.stale { border-left: 4px solid #ffc107; }
.conflict { border-left: 4px solid #fd7e14; }
.passed { border-left: 4px solid #28a745; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th { text-align: left; padding: 0.5rem; border-bottom: 2px solid #dee2e6; font-weight: 600; }
td { padding: 0.5rem; border-bottom: 1px solid #f1f3f5; }
.badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
.badge-pass { background: #d4edda; color: #155724; }
.badge-fail { background: #f8d7da; color: #721c24; }
.badge-stale { background: #fff3cd; color: #856404; }
.badge-reported { background: #e2e3e5; color: #383d41; }
.badge-blocked { background: #f8d7da; color: #721c24; }
.muted { color: #6c757d; }
.empty { color: #adb5bd; font-style: italic; }
@media print { body { background: #fff; } .section { break-inside: avoid; } }
`;

function badgeClass(status: string): string {
  switch (status) {
    case 'verified': return 'badge-pass';
    case 'failed': case 'rejected': return 'badge-fail';
    case 'stale': return 'badge-stale';
    case 'blocked': return 'badge-blocked';
    default: return 'badge-reported';
  }
}

export async function statusHtml(
  repoRoot: string,
  opts: { out?: string; baseBranch?: string } = {},
): Promise<{ outputPath: string; sizeBytes: number }> {
  const { events } = await readLedger(repoRoot);
  const state = replay(events);

  let baseBranch = opts.baseBranch ?? 'main';
  try {
    const policyText = await readFile(path.join(repoRoot, '.baton/policy.yml'), 'utf8');
    const policyRaw = yaml.parse(policyText) as { default_branch?: string } | null;
    if (policyRaw?.default_branch) baseBranch = policyRaw.default_branch;
  } catch { /* use default */ }

  let baseSha = 'unknown';
  try { baseSha = (await getCommitSha(repoRoot, baseBranch)).slice(0, 12); } catch { /* ignore */ }

  // Build task rows
  const tasksByStatus: Record<string, { id: string; title: string }[]> = {};
  for (const [id, t] of state.tasks) {
    const status = t.status;
    if (!tasksByStatus[status]) tasksByStatus[status] = [];
    // Read task title from file
    let title = '';
    try {
      const taskText = await readFile(path.join(repoRoot, 'project-memory/tasks', `${id}.md`), 'utf8');
      const m = taskText.match(/^title:\s*(.+)$/m);
      if (m) title = m[1]!.replace(/^["']|["']$/g, '');
    } catch { /* ignore */ }
    tasksByStatus[status]?.push({ id, title });
  }

  // Needs attention
  const needsAttention: { type: string; items: { id: string; detail: string }[] }[] = [];
  const needsWorkItems = (tasksByStatus['needs_work'] ?? []).map(t => ({ id: t.id, detail: t.title }));
  if (needsWorkItems.length > 0) needsAttention.push({ type: 'Needs work', items: needsWorkItems });
  const blockedItems = (tasksByStatus['blocked'] ?? []).map(t => ({ id: t.id, detail: t.title }));
  if (blockedItems.length > 0) needsAttention.push({ type: 'Blocked', items: blockedItems });

  // Stale claims
  const staleClaims = Array.from(state.claims.entries())
    .filter(([, c]) => c.status === 'stale')
    .map(([id, c]) => ({ id, statement: c.statement, taskId: c.taskId }));

  // Recent events (last 30)
  const recentEvents = events.slice(-30).map(e => {
    const ts = e.ts ?? '';
    const type = e.type ?? '';
    let task = '';
    if ('task' in e) task = e.task;
    let detail = '';
    if ('claim_id' in e) detail = e.claim_id;
    if ('decision' in e) detail = e.decision;
    if ('verdict' in e) detail = e.verdict;
    if ('reason' in e) detail = (e.reason as string).slice(0, 60);
    return { ts, type, task, detail };
  });

  // Claims by status
  const claimsByStatus: Record<string, { id: string; statement: string; taskId: string }[]> = {};
  for (const [id, c] of state.claims) {
    const status = c.status;
    if (!claimsByStatus[status]) claimsByStatus[status] = [];
    claimsByStatus[status]?.push({ id, statement: c.statement, taskId: c.taskId });
  }

  // Decisions
  const decisions: { id: string; status: string; key?: string }[] = [];
  for (const [id, d] of state.decisions) {
    decisions.push({ id, status: d.status, key: undefined });
  }

  // Assemble HTML
  const html = buildHtml(baseSha, tasksByStatus, needsAttention, staleClaims, recentEvents, claimsByStatus, decisions);

  // Write output
  const outPath = opts.out
    ? path.resolve(repoRoot, opts.out)
    : path.join(repoRoot, '.baton', 'status.html');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');

  const sizeBytes = Buffer.byteLength(html, 'utf8');
  if (sizeBytes > 5 * 1024 * 1024) {
    console.error(`Warning: status.html is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (threshold 5 MB)`);
  }

  return { outputPath: outPath, sizeBytes };
}

function buildHtml(
  baseSha: string,
  tasksByStatus: Record<string, { id: string; title: string }[]>,
  needsAttention: { type: string; items: { id: string; detail: string }[] }[],
  staleClaims: { id: string; statement: string; taskId: string }[],
  recentEvents: { ts: string; type: string; task: string; detail: string }[],
  claimsByStatus: Record<string, { id: string; statement: string; taskId: string }[]>,
  decisions: { id: string; status: string; key?: string }[],
): string {
  const parts: string[] = [];

  // Header
  parts.push(`<!DOCTYPE html>`);
  parts.push(`<html lang="en">`);
  parts.push(`<head>`);
  parts.push(`<meta charset="UTF-8">`);
  parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1.0">`);
  parts.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
  parts.push(`<title>Baton Status</title>`);
  parts.push(`<style>${STYLES}</style>`);
  parts.push(`</head>`);
  parts.push(`<body>`);
  parts.push(`<h1>Baton Status</h1>`);
  parts.push(`<p class="meta">As of base ${escapeHtml(baseSha)}</p>`);

  // Needs attention
  if (needsAttention.length > 0 || staleClaims.length > 0) {
    parts.push(`<div class="section needs-attention">`);
    parts.push(`<h2>Needs attention</h2>`);
    for (const na of needsAttention) {
      parts.push(`<h3>${escapeHtml(na.type)}</h3>`);
      parts.push(`<table><tbody>`);
      for (const item of na.items) {
        parts.push(`<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.detail)}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    if (staleClaims.length > 0) {
      parts.push(`<h3>Stale claims (${staleClaims.length})</h3>`);
      parts.push(`<table><tbody>`);
      for (const sc of staleClaims) {
        parts.push(`<tr><td>${escapeHtml(sc.id)}</td><td>${escapeHtml(sc.statement)}</td><td>${escapeHtml(sc.taskId)}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    parts.push(`</div>`);
  }

  // Tasks by status
  parts.push(`<div class="section">`);
  parts.push(`<h2>Tasks by status</h2>`);
  const taskStatuses = Object.keys(tasksByStatus).sort();
  if (taskStatuses.length === 0) {
    parts.push(`<p class="empty">No tasks.</p>`);
  } else {
    for (const status of taskStatuses) {
      const tasks = tasksByStatus[status] ?? [];
      parts.push(`<h3>${escapeHtml(status)} (${tasks.length})</h3>`);
      parts.push(`<table><thead><tr><th>ID</th><th>Title</th></tr></thead><tbody>`);
      for (const t of tasks) {
        parts.push(`<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.title)}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
  }
  parts.push(`</div>`);

  // Decisions
  parts.push(`<div class="section">`);
  parts.push(`<h2>Decisions</h2>`);
  if (decisions.length === 0) {
    parts.push(`<p class="empty">No decisions.</p>`);
  } else {
    parts.push(`<table><thead><tr><th>ID</th><th>Status</th></tr></thead><tbody>`);
    for (const d of decisions) {
      parts.push(`<tr><td>${escapeHtml(d.id)}</td><td><span class="badge ${badgeClass(d.status)}">${escapeHtml(d.status)}</span></td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }
  parts.push(`</div>`);

  // Claims by status
  parts.push(`<div class="section">`);
  parts.push(`<h2>Claims by status</h2>`);
  const claimStatuses = Object.keys(claimsByStatus).sort();
  if (claimStatuses.length === 0) {
    parts.push(`<p class="empty">No claims.</p>`);
  } else {
    for (const status of claimStatuses) {
      const claims = claimsByStatus[status] ?? [];
      parts.push(`<h3>${escapeHtml(status)} (${claims.length})</h3>`);
      parts.push(`<table><thead><tr><th>ID</th><th>Statement</th><th>Task</th></tr></thead><tbody>`);
      for (const c of claims) {
        parts.push(`<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.statement)}</td><td>${escapeHtml(c.taskId)}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
  }
  parts.push(`</div>`);

  // Recent events
  parts.push(`<div class="section">`);
  parts.push(`<h2>Recent events (last ${recentEvents.length})</h2>`);
  if (recentEvents.length === 0) {
    parts.push(`<p class="empty">No events.</p>`);
  } else {
    parts.push(`<table><thead><tr><th>Timestamp</th><th>Type</th><th>Task</th><th>Detail</th></tr></thead><tbody>`);
    for (const e of recentEvents) {
      parts.push(`<tr><td class="muted">${escapeHtml(e.ts)}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.task)}</td><td>${escapeHtml(e.detail)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }
  parts.push(`</div>`);

  parts.push(`</body></html>`);

  return parts.join('\n');
}
