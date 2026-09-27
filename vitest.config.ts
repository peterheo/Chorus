import { defineConfig } from 'vitest/config';

// Integration tests hit a real PostgreSQL (DATABASE_URL); they never run under the unit project.
export default defineConfig({
  test: {
    // The integration suites open many PostgreSQL connections (100-way races); running at most three
    // files at once keeps the peak well under the default max_connections of 100.
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
