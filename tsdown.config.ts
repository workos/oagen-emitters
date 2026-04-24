import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: { index: 'src/index.ts', plugin: 'src/plugin.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
});
