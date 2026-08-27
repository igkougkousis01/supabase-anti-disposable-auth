import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Integration tests skip themselves unless SADA_TEST_DB_URL is present -- never
    // SUPABASE_DB_URL, which is the credential the CLI uses against a real project.
    // Keeping the default `npm test` scoped to tests/unit makes that guarantee obvious.
    passWithNoTests: false,
  },
});
