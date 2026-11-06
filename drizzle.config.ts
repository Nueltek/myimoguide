import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    // drizzle-kit runs on Node, not in the Worker, so this comes from the
    // shell environment rather than a Worker binding.
    url: process.env.DATABASE_URL!,
  },
  // pgvector must exist before the intents table's index is created.
  // Run once against Neon: CREATE EXTENSION IF NOT EXISTS vector;
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
