// G24 enforcement: forbid network imports in src/
import fs from 'node:fs';
import path from 'node:path';

const DENY = [
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:dns',
  'node:tls',
  'fetch(',
  'child_process.exec',
  'from \'net\'',
  'from \'http\'',
  'from \'https\'',
  'from \'dns\'',
  'from \'tls\'',
  'from \'dgram\'',
];

let fail = false;
const srcDir = path.resolve(process.cwd(), 'src');
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const txt = fs.readFileSync(full, 'utf8');
      const rel = path.relative(srcDir, full);
      for (const d of DENY) {
        if (txt.includes(d)) {
          console.error(`G24 FAIL: ${rel} contains "${d}"`);
          fail = true;
        }
      }
    }
  }
}
walk(srcDir);
if (fail) {
  console.error('G24 failed: network code detected in src/');
  process.exit(1);
}
console.log('G24 pass: no network imports detected in src/');
