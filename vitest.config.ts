import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Integration tests skip themselves unless SUPABASE_DB_URL is present, but keeping the
    // default `npm test` scoped to tests/unit makes that guarantee obvious.
    passWithNoTests: false,
  },
});
