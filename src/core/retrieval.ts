// Semantic retrieval engine (BM25). v1.3 Stage 5b (Reach: retrieval).
// Deterministic, no AI, no network, no native deps. BM25 over repo files:
//   score(D,Q) = Σ_t IDF(t) · tf(t,D)·(k1+1) / (tf(t,D) + k1·(1 - b + b·|D|/avgdl))
// with k1 = 1.5, b = 0.75, IDF(t) = ln(1 + (N - df + 0.5) / (df + 0.5)).
//
// Security model (mirrors packet T2/T7 rules):
//   - never_include globs are always excluded (P0-14 list)
//   - per-file secret scan before indexing (a file with secrets is never indexed)
//   - binary extensions and oversized files skipped
//   - generated / dependency directories skipped (node_modules, .git, dist, ...)
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMatch, toPosix } from './globs.js';
import { scan } from './secrets.js';
import type { Policy } from './schemas.js';

export const K1 = 1.5;
export const B = 0.75;
export const MAX_FILE_BYTES = 200_000;
export const DEFAULT_TOP = 8;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__',
  '.baton', '.next', '.turbo', '.cache', 'vendor', '.venv', 'venv', 'target',
  '.idea', '.vscode', '.gradle', 'tmp',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.class', '.jar', '.pyc', '.wasm', '.db', '.sqlite', '.sqlite3', '.lock',
]);

const TEXT_EXT_INDEX = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.txt', '.sql',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.env.example', '.prisma',
  '.graphql', '.proto', '.xml', '.vue', '.svelte', '.astro', '.tf', '.ini',
  '.cfg', '.conf', '.gitignore', '.dockerignore', '.editorconfig',
]);

// Small English stopword list — keeps BM25 focused on content terms.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'there', 'here', 'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my',
  'our', 'your', 'their', 'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'not', 'no', 'yes', 'so', 'such', 'than', 'too', 'very', 'can', 'will',
  'just', 'should', 'now', 'also', 'into', 'about', 'over', 'under', 'up',
  'down', 'out', 'off', 'again', 'each', 'any', 'all', 'both', 'more', 'most',
  'other', 'some', 'only', 'own', 'same', 's', 't', 'don', 'll', 're', 've',
]);

export interface RetrievalHit {
  path: string;
  score: number;
  snippet: string;
}

export interface RetrieveOptions {
  top?: number;
  /** extra glob filters: only files matching at least one glob are indexed */
  globs?: string[];
  /** paths already present in the packet (reads / include-files) — skip re-surfacing */
  excludePaths?: Set<string>;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // bare numbers carry no meaning
    out.push(raw);
  }
  return out;
}

// ---------- index ----------

interface IndexedDoc {
  path: string;
  tf: Map<string, number>;
  len: number;
}

export interface Bm25Index {
  docs: IndexedDoc[];
  avgdl: number;
  postings: Map<string, number[]>; // term -> doc indices
}

export function buildIndex(files: { path: string; content: string }[]): Bm25Index {
  const docs: IndexedDoc[] = [];
  const postings = new Map<string, number[]>();
  let totalLen = 0;

  for (const file of files) {
    const terms = tokenize(file.content);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const docId = docs.length;
    docs.push({ path: file.path, tf, len: terms.length });
    totalLen += terms.length;
    for (const term of tf.keys()) {
      const list = postings.get(term);
      if (list) list.push(docId);
      else postings.set(term, [docId]);
    }
  }

  return { docs, avgdl: docs.length > 0 ? totalLen / docs.length : 0, postings };
}

export function bm25Search(index: Bm25Index, query: string, top = DEFAULT_TOP): { path: string; score: number }[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || index.docs.length === 0) return [];

  const n = index.docs.length;
  const scores = new Map<number, number>();

  for (const term of queryTerms) {
    const docIds = index.postings.get(term);
    if (!docIds || docIds.length === 0) continue;
    const df = docIds.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const docId of docIds) {
      const doc = index.docs[docId];
      if (!doc) continue;
      const tf = doc.tf.get(term) ?? 0;
      const norm = 1 - B + B * (doc.len / (index.avgdl || 1));
      const s = idf * (tf * (K1 + 1)) / (tf + K1 * norm);
      scores.set(docId, (scores.get(docId) ?? 0) + s);
    }
  }

  const ranked = Array.from(scores.entries())
    .map(([docId, score]) => ({ path: index.docs[docId]?.path ?? '', score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranked.slice(0, top);
}

// ---------- snippet ----------

export function makeSnippet(content: string, query: string, maxLines = 3): string {
  const lines = content.split('\n');
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || lines.length === 0) {
    return lines.slice(0, maxLines).map(l => l.trim().slice(0, 120)).join(' ⏎ ');
  }

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineTerms = tokenize(line);
    let s = 0;
    for (const t of lineTerms) if (queryTerms.has(t)) s++;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const window = lines.slice(start, start + maxLines)
    .map(l => l.trim().slice(0, 120))
    .filter(l => l.length > 0);
  return window.join(' ⏎ ').slice(0, 300);
}

// ---------- file collection ----------

function isTextCandidate(filePath: string): boolean {
  const posix = toPosix(filePath).toLowerCase();
  if (BINARY_EXT.has(path.posix.extname(posix))) return false;
  if (posix.endsWith('.lock') || posix.endsWith('.min.js') || posix.endsWith('.min.css')) return false;
  const ext = path.posix.extname(posix);
  if (ext === '') {
    // Extensionless: allow known metadata files (Makefile, Dockerfile, LICENSE, .gitignore...)
    const base = path.posix.basename(posix);
    return /^(makefile|dockerfile|procfile|license|readme|changelog|contributing|authors)$/i.test(base)
      || base.startsWith('.');
  }
  return true;
}

export async function collectCandidateFiles(
  repoRoot: string,
  policy: Policy,
  globs?: string[],
): Promise<string[]> {
  const candidates: string[] = [];
  const root = path.resolve(repoRoot);

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 20) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), relPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isTextCandidate(relPath)) continue;
      // never_include is an absolute veto (P0-14)
      if (policy.never_include.some(g => isMatch(relPath, g))) continue;
      // optional user glob filter
      if (globs && globs.length > 0 && !globs.some(g => isMatch(relPath, g))) continue;
      candidates.push(relPath);
    }
  };

  await walk(root, '', 0);
  return candidates;
}

// ---------- top-level retrieval ----------

export async function retrieve(
  repoRoot: string,
  policy: Policy,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievalHit[]> {
  const trimmed = (query ?? '').trim();
  if (trimmed.length === 0) return [];
  const top = opts.top ?? DEFAULT_TOP;

  const paths = await collectCandidateFiles(repoRoot, policy, opts.globs);

  const files: { path: string; content: string }[] = [];
  for (const rel of paths) {
    if (opts.excludePaths?.has(toPosix(rel))) continue;
    const abs = path.join(repoRoot, rel);
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const content = await readFile(abs, 'utf8');
      // A file with secrets is never indexed (same bar as packet T7)
      if (scan(content, policy.extra_secret_patterns).length > 0) continue;
      if (content.trim().length === 0) continue;
      files.push({ path: toPosix(rel), content });
    } catch {
      continue;
    }
  }

  const index = buildIndex(files);
  const ranked = bm25Search(index, trimmed, top);

  return ranked.map(r => ({
    path: r.path,
    score: r.score,
    snippet: makeSnippet(files.find(f => f.path === r.path)?.content ?? '', trimmed),
  }));
}
