// Filesystem safety helpers. G10, G11, G14.
import { mkdir, writeFile, readFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a path and verify it stays inside the repo root.
 * Rejects .. and symlinks that resolve outside.
 */
export async function ensureInside(repoRoot: string, p: string): Promise<string> {
  const abs = path.resolve(repoRoot, p);
  // Verify the path is inside repoRoot (after symlink resolution if the path exists)
  try {
    const realRepo = await realpath(repoRoot);
    // If the path exists, resolve its realpath; otherwise compare against resolved abs
    try {
      const realAbs = await realpath(abs);
      if (!realAbs.startsWith(realRepo + path.sep) && realAbs !== realRepo) {
        throw new Error(`path escapes repo: ${p}`);
      }
      return realAbs;
    } catch {
      // Path doesn't exist yet — compare lexical
      if (!abs.startsWith(realRepo + path.sep) && abs !== realRepo) {
        throw new Error(`path escapes repo: ${p}`);
      }
      return abs;
    }
  } catch {
    throw new Error(`path escapes repo: ${p}`);
  }
}

/**
 * Atomic write: temp file in same dir, then rename. G11.
 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/**
 * Read file as UTF-8, stripping BOM. G14.
 */
export async function readText(file: string): Promise<string> {
  const buf = await readFile(file);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

/**
 * File size in bytes. Used by G14 size limits.
 */
export async function fileSize(file: string): Promise<number> {
  const s = await stat(file);
  return s.size;
}
