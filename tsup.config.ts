import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  // Each entry must be self-contained: `cli.ts` decides whether it is the process
  // entry point by comparing `import.meta.url` with argv[1], which only holds if the
  // executed file is the one containing that check.
  splitting: false,
  sourcemap: true,
  clean: true,
  // Runtime dependencies stay external so `pg` keeps its native/optional resolution behaviour.
  external: ['commander', 'pg', 'zod'],
});
