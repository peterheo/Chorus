import { defineConfig } from 'vitest/config';

// Integration tests hit a real PostgreSQL (DATABASE_URL); they never run under the unit project.
export default defineConfig({
  test: {
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
