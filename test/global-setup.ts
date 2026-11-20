// v1.3.2 P3 (test speed): build dist/cli.js once before the suite when src is
// newer than the build. Integration tests then spawn `node dist/cli.js`
// (~80 ms startup) instead of `npx tsx src/cli.ts` (~700 ms per spawn) — the
// suite makes hundreds of CLI spawns. The tsx fallback keeps `vitest run`
// working when no build exists (helpers.cliRunner falls back automatically).
import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

export default function globalSetup(): void {
  const distCli = path.join(root, 'dist', 'cli.js');
  let stale = true;
  try {
    stale = !existsSync(distCli) || newestMtime(path.join(root, 'src')) > statSync(distCli).mtimeMs;
  } catch { stale = true; }
  if (stale) {
    execSync('npx tsup src/cli.ts --format esm', { cwd: root, stdio: 'pipe', timeout: 180000 });
  }
}
