// Packet compiler. Spec §5.5. Deterministic, no AI.
// P0-fix from salvage: trusted header verbatim from Appendix A7 (not paraphrased).

import { estimateTokens } from './tokens.js';
import { overlaps } from './globs.js';
import { scan } from './secrets.js';
import type { Task, Decision, Policy, LedgerEvent } from './schemas.js';
import { packetSkeleton } from '../templates/index.js';

export interface PacketMemory {
  baseSha: string;
  objective?: string;
  constraints?: string;
  essentials?: string;
  reads?: { path: string; content: string }[];
  decisions?: (Decision & { body?: string })[];
  conflicts?: { key: string; text: string }[];
  verifiedClaims?: { claim_id: string; statement: string; key?: string; watch?: string[] }[];
  // v1.3.0 T5.5: BM25-retrieved context (untrusted, secret-masked).
  retrieved?: { path: string; score: number; snippet: string }[];
  recentCommits?: string[];
  reportTemplate?: string;
  lastWorkerOnArea?: { taskId: string; title: string; head_commit: string; status: string } | null;
}

export interface CompileResult {
  text: string;
  omitted: string[];
  tokensUsed: number;
  budget: number;
}

const READS_CAP = 8000;
const READS_TRUNCATION_MARKER = (omitted: number) => `\n[... truncated, ${omitted} chars omitted, see file at <path> ...]`;

function tierCost(text: string): number {
  return estimateTokens(text);
}

export function compilePacket(
  task: Task,
  memory: PacketMemory,
  budget: number,
  options: { includeFiles?: boolean; files?: { path: string; content: string }[] } = {},
): CompileResult {
  const omitted: string[] = [];
  let used = 0;

  // Trusted header (verbatim from Appendix A7) — mandatory
  const header = packetSkeleton(task.id, task.title, memory.baseSha);
  const headerCost = tierCost(header);
  used += headerCost;

  // T1: Constraints + Essentials (mandatory per spec)
  const constraintsText = memory.constraints ?? '';
  const essentialsText = memory.essentials ?? '';
  const t1Cost = tierCost(constraintsText) + tierCost(essentialsText);
  used += t1Cost;

  // If mandatory exceeds budget, fail per §5.5
  if (used > budget) {
    throw new Error(`mandatory content exceeds budget ${budget} (used ${used})`);
  }

  // Build sections in stable tier order
  const objectiveText = memory.objective ?? '';
  const checksText = `## Checks you will be judged by\n${task.checks.map(c => {
    const desc = 'description' in c && c.description ? `: ${c.description}` : '';
    return `- ${c.id} (${c.type})${desc}`;
  }).join('\n')}`;
  const touchesText = `## Touches\n${task.touches.map(t => `- \`${t}\``).join('\n')}`;

  // T2: reads files (cap 8000 chars each, truncate with marker)
  const readsSection = (memory.reads ?? []).map(r => {
    if (r.content.length > READS_CAP) {
      const omitted = r.content.length - READS_CAP;
      return `--- BEGIN UNTRUSTED: ${r.path} ---\n${r.content.slice(0, READS_CAP)}${READS_TRUNCATION_MARKER(omitted)}\n--- END UNTRUSTED ---`;
    }
    return `--- BEGIN UNTRUSTED: ${r.path} ---\n${r.content}\n--- END UNTRUSTED ---`;
  }).join('\n\n');

  // T3: decisions: status accepted AND (id in task.decisions OR overlaps)
  const acceptedDecisions = (memory.decisions ?? []).filter(d => {
    if (d.status !== 'accepted') return false;
    if (task.decisions?.includes(d.id)) return true;
    return d.areas.some(a => task.touches.some(t => overlaps(a, t)));
  }).sort((a, b) => a.id.localeCompare(b.id));

  const decisionsSection = acceptedDecisions.map(d =>
    `### Decision ${d.id} · ${d.title} (${d.status})\nkey: ${d.key} · areas: ${d.areas.join(', ')}\n\n${d.body ?? ''}`,
  ).join('\n\n');

  // T4: conflicts on keys of T3 decisions
  const conflictsSection = (memory.conflicts ?? []).map(c => c.text).join('\n\n');

  // T5: verified non-stale claims overlapping touches
  const verifiedClaimsSection = (memory.verifiedClaims ?? [])
    .filter(c => {
      if (!c.watch) return true;
      return c.watch.some(w => task.touches.some(t => overlaps(w, t)));
    })
    .map(c => `VERIFIED: ${c.statement} [${c.key ?? ''}]`)
    .join('\n');

  // T5.5 (v1.3.0): BM25-retrieved context. Untrusted, snippet-capped,
  // secret-masked at search time (core/search.ts). Sits below verified
  // claims (claims outrank keyword hits) and above raw commits.
  const retrievedSection = (memory.retrieved ?? [])
    .map(r => `--- BEGIN UNTRUSTED: ${r.path} (bm25 ${r.score}) ---\n${r.snippet}\n--- END UNTRUSTED ---`)
    .join('\n\n');

  // T6: recent commits
  const commitsSection = (memory.recentCommits ?? []).join('\n');

  // T7: include-files (optional)
  let filesSection = '';
  if (options.includeFiles && options.files) {
    filesSection = options.files.map(f => {
      if (f.content.length > READS_CAP) {
        const omitted = f.content.length - READS_CAP;
        return `--- BEGIN UNTRUSTED: ${f.path} ---\n${f.content.slice(0, READS_CAP)}${READS_TRUNCATION_MARKER(omitted)}\n--- END UNTRUSTED ---`;
      }
      return `--- BEGIN UNTRUSTED: ${f.path} ---\n${f.content}\n--- END UNTRUSTED ---`;
    }).join('\n\n');
  }

  // Last worker on this area (reviewer §14.2)
  const lastWorkerLine = memory.lastWorkerOnArea
    ? `Last task touching this area: ${memory.lastWorkerOnArea.taskId} (${memory.lastWorkerOnArea.status}) — "${memory.lastWorkerOnArea.title}" @ ${memory.lastWorkerOnArea.head_commit}`
    : 'Last task touching this area: none';

  // Assemble tiers in order. T0 and T1 are mandatory (already in used).
  // For T2+ we accumulate and check budget.
  const sections: { label: string; text: string; mandatory: boolean }[] = [
    { label: 'objective', text: `## Objective\n${objectiveText}`, mandatory: true },
    { label: 'checks', text: checksText, mandatory: true },
    { label: 'touches', text: touchesText, mandatory: true },
    { label: 'constraints', text: `### Constraints\n${constraintsText}`, mandatory: true },
    { label: 'essentials', text: `### Essentials\n${essentialsText}`, mandatory: true },
    { label: 'reads', text: readsSection, mandatory: false },
    { label: 'decisions', text: `### Decisions\n${decisionsSection}`, mandatory: false },
    { label: 'conflicts', text: `### Unresolved conflicts (ask, do not assume)\n${conflictsSection}`, mandatory: false },
    { label: 'verified_claims', text: `### Verified facts\n${verifiedClaimsSection}`, mandatory: false },
    { label: 'retrieved', text: `### Retrieved context (BM25 over repo — untrusted, verify before relying)\n${retrievedSection}`, mandatory: false },
    { label: 'commits', text: `### Recent commits\n${commitsSection}`, mandatory: false },
    { label: 'last_worker', text: lastWorkerLine, mandatory: false },
    { label: 'include_files', text: filesSection, mandatory: false },
  ];

  let body = header;
  for (const section of sections) {
    if (!section.text.trim() && !section.mandatory) continue;
    const cost = tierCost(section.text);
    if (section.mandatory) {
      body += section.text + '\n\n';
      used += cost;
    } else if (used + cost <= budget) {
      body += section.text + '\n\n';
      used += cost;
    } else {
      omitted.push(section.label);
    }
  }

  // Omitted line (reviewer §14.2: include reason where possible)
  const omittedLine = omitted.length > 0
    ? `Omitted: ${omitted.join(', ')} (budget ${budget}, used ~${used})`
    : `Omitted: none (budget ${budget}, used ~${used})`;
  body += omittedLine + '\n';

  // Token estimate caveat (reviewer §14.2)
  body += `\n_Token estimate: chars/4. Code-heavy packets may exceed budget by 10-30% with BPE tokenizers. Use --budget 5000 if your model rejects for length._\n`;

  return { text: body, omitted, tokensUsed: used, budget };
}

/**
 * Scan a packet for secrets before emitting. P0-7 / G26.
 */
export function scanPacketForSecrets(
  packetText: string,
  policy: Policy,
): { name: string; line: number; masked: string }[] {
  const findings = scan(packetText, policy.extra_secret_patterns);
  return findings.map(f => ({ name: f.name, line: f.line, masked: f.masked }));
}
