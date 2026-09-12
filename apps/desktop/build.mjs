import { build as bundle } from 'esbuild';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({ base: './', plugins: [react()], build: { outDir: 'dist/renderer', emptyOutDir: true } });
await bundle({ entryPoints: ['src/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
await bundle({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
await bundle({ entryPoints: ['src/validation.ts'], outfile: 'dist/validation.js', bundle: true, platform: 'node', format: 'esm', target: 'node24' });

await bundle({ entryPoints: ['src/memory-validation.ts'], outfile: 'dist/memory-validation.js', bundle: true, platform: 'node', format: 'esm', target: 'node24' });
