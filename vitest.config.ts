import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Never load PostCSS/Tailwind configs from parent directories — keeps the
  // test run hermetic when this repo is nested inside another project.
  css: { postcss: { plugins: [] } },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
  },
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
});
