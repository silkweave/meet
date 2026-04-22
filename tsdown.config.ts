import { defineConfig, type UserConfig } from 'tsdown'
import pkg from './package.json' with { type: "json" }

const shared: UserConfig = {
  outDir: 'build',
  sourcemap: true,
  dts: true,
  deps: { neverBundle: ['zod', 'googleapis', 'google-auth-library'] },
  format: ['esm'],
  define: { __VERSION__: JSON.stringify(pkg.version) },
}

export default defineConfig([{
  ...shared,
  entry: ['./src/index.ts'],
}, {
  ...shared,
  entry: ['src/cli.ts'],
  banner: { js: '#!/usr/bin/env node' }
}, {
  ...shared,
  entry: ['src/mcp.ts'],
  banner: { js: '#!/usr/bin/env node' }
}])
