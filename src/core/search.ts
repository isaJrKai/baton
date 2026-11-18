// v1.3.0 — baton search: BM25 retrieval over the repo corpus.
// Feeds the packet's `retrieved` tier (T5.5) and the `baton search` command.
//
// Design rules (Baton invariants):
// - Deterministic: same corpus + query -> same ranking, no AI, no network.
// - Never include secrets: policy.never_include globs are excluded from the
//   corpus entirely, and every emitted snippet is secret-masked.
// - Bounded: file size cap + corpus cap + snippet cap, so packets stay honest
//   about what they had to leave out (the packet's Omitted line handles the rest).
//
// BM25 (k1=1.5, b=0.75) over whitespace/punctuation tokenized text.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMatch } from './globs.js';
import { scan, SECRET_PATTERNS, mask, type SecretPattern } from './secrets.js';

export const SEARCH_K1 = 1.5;
export const SEARCH_B = 0.75;
export const MAX_FILE_BYTES = 64 * 1024;       // 64KB per file indexed
export const MAX_CORPUS_FILES = 2000;          // hard corpus cap
export const SNIPPET_CHARS = 280;              // snippet window
export const DEFAULT_TOP = 8;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next',
  '.baton', '.venv', 'venv', '__pycache__', 'coverage', '.cache',
]);

// Text-ish extensions worth indexing. Binaries are skipped by extension;
// anything without an extension is treated as text unless it contains NUL.
const TEXT_EXT = new Set([
  '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.css', '.scss', '.html',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.sh', '.bash', '.zsh', '.sql', '.prisma', '.graphql', '.xml',
  '.svg', '.vue', '.svelte', '.tf', '.env.example', '.lock',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at',
  'by', 'for', 'with', 'about', 'into', 'to', 'of', 'in', 'on', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'from', 'not', 'no', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might',
  'we', 'you', 'they', 'he', 'she', 'our', 'your', 'their', 'my',
]);

export interface SearchDoc {
  path: string;       // POSIX repo-relative
  text: string;
  terms: Map<string, number>;   // term -> tf
  length: number;     // token count
}

export interface SearchResult {
  path: string;
  score: number;
  snippet: string;
}

export interface SearchIndex {
  docs: SearchDoc[];
  df: Map<string, number>;      // term -> document frequency
  avgLen: number;
  totalTerms: number;
}

// ---------- tokenization ----------

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

// ---------- corpus collection ----------

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (ext === '') {
    // Allow extensionless known files (Dockerfile, Makefile, LICENSE, ...)
    return /^(Dockerfile|Makefile|LICENSE|README|CHANGELOG|NOTICE)/i.test(name);
  }
  return TEXT_EXT.has(ext);
}

async function walk(
  root: string,
  dir: string,
  neverInclude: string[],
  budget: { files: number },
  out: string[],
): Promise<void> {
  if (budget.files <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.files <= 0) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, full, neverInclude, budget, out);
      continue;
    }
    if (!e.isFile()) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (neverInclude.some(g => isMatch(rel, g))) continue;
    if (!isTextFile(e.name)) continue;
    try {
      const s = await stat(full);
      if (s.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(full);
      // Binary sniff: NUL byte in first 8KB
      if (buf.subarray(0, 8192).includes(0)) continue;
      out.push(rel);
      budget.files--;
    } catch {
      // unreadable — skip
    }
  }
}

export async function collectCorpus(
  repoRoot: string,
  neverInclude: string[],
): Promise<string[]> {
  const files: string[] = [];
  const budget = { files: MAX_CORPUS_FILES };
  await walk(repoRoot, repoRoot, neverInclude, budget, files);
  return files.sort(); // deterministic order
}

// ---------- indexing ----------

export async function buildIndex(
  repoRoot: string,
  neverInclude: string[],
  files?: string[],
): Promise<SearchIndex> {
  const list = files ?? await collectCorpus(repoRoot, neverInclude);
  const docs: SearchDoc[] = [];
  const df = new Map<string, number>();
  let totalTerms = 0;

  for (const rel of list) {
    let text: string;
    try {
      text = await readFile(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    const tf = termFreq(tokens);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    totalTerms += tokens.length;
    docs.push({ path: rel, text, terms: tf, length: tokens.length });
  }

  const avgLen = docs.length > 0 ? totalTerms / docs.length : 0;
  return { docs, df, avgLen, totalTerms };
}

// ---------- scoring ----------

function idf(df: Map<string, number>, n: number, term: string): number {
  const f = df.get(term) ?? 0;
  // BM25 classic IDF with 0.5 smoothing, floored at 0
  return Math.max(0, Math.log((n - f + 0.5) / (f + 0.5) + 1));
}

export function scoreDocs(index: SearchIndex, queryTerms: string[]): { doc: SearchDoc; score: number }[] {
  const n = index.docs.length;
  const results: { doc: SearchDoc; score: number }[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const qt of queryTerms) {
      const tf = doc.terms.get(qt) ?? 0;
      if (tf === 0) continue;
      const numerator = tf * (SEARCH_K1 + 1);
      const denominator = tf + SEARCH_K1 * (1 - SEARCH_B + SEARCH_B * (doc.length / (index.avgLen || 1)));
      score += idf(index.df, n, qt) * (numerator / denominator);
    }
    if (score > 0) results.push({ doc, score });
  }
  // Deterministic order: score desc, then path asc
  results.sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path));
  return results;
}

// ---------- snippet extraction ----------

export function extractSnippet(
  text: string,
  queryTerms: string[],
  maskedScan: { line: number }[],
): string {
  const secretLines = new Set(maskedScan.map(f => f.line));

  const lower = text.toLowerCase();
  // Find the first window containing the most query terms.
  let bestStart = 0;
  let bestHits = -1;
  const step = 60;
  for (let start = 0; start < Math.max(1, lower.length - step); start += step) {
    const window = lower.slice(start, start + SNIPPET_CHARS + 80);
    let hits = 0;
    for (const qt of queryTerms) if (window.includes(qt)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      bestStart = start;
      if (hits === queryTerms.length) break;
    }
  }

  let snippet = text.slice(bestStart, bestStart + SNIPPET_CHARS).trim();
  if (bestStart > 0) snippet = '...' + snippet;
  if (bestStart + SNIPPET_CHARS < text.length) snippet = snippet + '...';
  // Collapse whitespace so packets stay compact
  snippet = snippet.replace(/\s+/g, ' ');

  // Defense-in-depth: mask every secret-pattern occurrence INSIDE the snippet
  // text (the snippet may straddle multiple source lines).
  snippet = maskSecretsInText(snippet);

  // If the snippet's leading source line is a known secret line, withhold.
  const lines = text.split('\n');
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = acc;
    acc += lines[i]!.length + 1;
    if (lineStart <= bestStart && bestStart < acc && secretLines.has(i + 1)) {
      return '(snippet withheld: secret pattern on source line)';
    }
  }
  return snippet;
}

/**
 * Replace every secret-pattern match in text with its masked form.
 * Uses the same patterns as core/secrets.ts so behavior is consistent.
 */
export function maskSecretsInText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS as SecretPattern[]) {
    p.regex.lastIndex = 0;
    out = out.replace(p.regex, (m) => mask(m));
  }
  return out;
}

// ---------- public API ----------

export interface SearchOptions {
  top?: number;
  neverInclude?: string[];
  extraSecretPatterns?: { name: string; regex: string }[];
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  corpusFiles: number;
}

export async function searchRepo(
  repoRoot: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const index = await buildIndex(repoRoot, opts.neverInclude ?? []);
  return searchIndex(index, query, opts);
}

export function searchIndex(
  index: SearchIndex,
  query: string,
  opts: SearchOptions = {},
): SearchResponse {
  const queryTerms = tokenize(query);
  const scored = scoreDocs(index, queryTerms);
  const top = opts.top ?? DEFAULT_TOP;

  const results: SearchResult[] = [];
  for (const { doc, score } of scored.slice(0, top)) {
    const findings = scan(doc.text, opts.extraSecretPatterns ?? []);
    const snippet = extractSnippet(doc.text, queryTerms, findings);
    results.push({ path: doc.path, score: Math.round(score * 1000) / 1000, snippet });
  }
  return { query, results, corpusFiles: index.docs.length };
}
