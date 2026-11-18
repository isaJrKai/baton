import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  // src/cli.ts already carries the shebang; tsup preserves it in the bundle.
  target: 'node20',
});
