import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Note: tsup preserves the shebang line from the entry file automatically;
  // do not add a js banner or the shebang will be duplicated.
});
