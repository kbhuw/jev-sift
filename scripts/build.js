import { build } from 'esbuild';
await build({ entryPoints: ['src/server.js'], outfile: 'dist/server.mjs', bundle: true,
  platform: 'node', target: 'node20', format: 'esm', minify: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
