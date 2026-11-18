import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
  },
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
});
