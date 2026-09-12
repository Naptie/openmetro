import { defineConfig } from "tsup";

/**
 * The client is a types-only package: consumers install it and get a fully
 * typed Eden Treaty factory. `@openmetro/core` is a private workspace package, so it
 * must be inlined into the emitted `index.d.ts` (never left as a bare import).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  dts: { only: true, resolve: true },
  tsconfig: "tsconfig.dts.json",
  noExternal: ["@openmetro/core"],
  clean: true,
});
