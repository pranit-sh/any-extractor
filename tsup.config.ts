import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { mcp: 'src/mcp/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
