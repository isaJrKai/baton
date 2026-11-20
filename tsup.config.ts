import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // v1.3.2: keep dist/cli.js self-contained. tsup's esm code-splitting emits
  // hash-named chunk files; the committed single-file cli.js (installed via
  // `npm install -g github:isaJrKai/baton`) would otherwise reference chunks
  // that never ship.
  splitting: false,
  // Note: tsup preserves the shebang line from the entry file automatically;
  // do not add a js banner or the shebang will be duplicated.
});
