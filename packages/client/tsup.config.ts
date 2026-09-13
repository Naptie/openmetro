import { defineConfig } from 'tsup';

/**
 * The client is a types-only package: consumers install it and get a fully
 * typed Eden Treaty factory. `@openmetro/core` is a private workspace package, so it
 * must be inlined into the emitted `index.d.ts` (never left as a bare import).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: { only: true, resolve: true },
  tsconfig: 'tsconfig.dts.json',
  noExternal: ['@openmetro/core'],
  // `effect` types leak into the public `App` surface (core's schemas are
  // effect `Schema` classes). They must stay a real `import from "effect"`,
  // not be "resolved": tsup's dts resolver can't inline effect's declarations
  // and rewrites the imports to relative chunk paths (./Effect.js) that are
  // never emitted, publishing a broken d.ts. The staged package declares
  // `effect` as a peer dependency so the import resolves for consumers.
  external: [/^effect($|\/)/],
  clean: true
});
