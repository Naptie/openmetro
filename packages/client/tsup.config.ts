import { defineConfig } from 'tsup';

/**
 * The client ships two entries, both with real ESM JS and declarations:
 *
 * - `.` (index.ts) — the typed Eden Treaty factory. `@openmetro/core` is a
 *   private workspace package, so it must be inlined into the emitted
 *   `index.d.ts` (never left as a bare import).
 * - `./schemas` (schemas.ts) — zod runtime validation schemas, generated from
 *   `@openmetro/core`'s wire schemas. The main entry never imports zod, so it
 *   stays installable without it.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', schemas: 'src/schemas.ts' },
  outDir: 'dist',
  format: ['esm'],
  dts: { resolve: true },
  tsconfig: 'tsconfig.dts.json',
  noExternal: ['@openmetro/core'],
  // `effect` types leak into the public `App` surface (core's schemas are
  // effect `Schema` classes). They must stay a real `import from "effect"`,
  // not be "resolved": tsup's dts resolver can't inline effect's declarations
  // and rewrites the imports to relative chunk paths (./Effect.js) that are
  // never emitted, publishing a broken d.ts. The staged package declares
  // `effect` as a peer dependency so the import resolves for consumers.
  //
  // `zod` stays a real import in `schemas.js` too, so consumers dedupe their
  // own zod install. The staged package declares it as an *optional* peer:
  // the main entry needs neither zod nor its types.
  external: [/^effect($|\/)/, /^zod($|\/)/],
  clean: true
});
