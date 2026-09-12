/**
 * Export the generated OpenAPI document to `dist/openapi.json`.
 *
 * Uses the app's own `/swagger/json` route, so the published document can never
 * drift from the running server.
 *
 * Usage: `bun run scripts/export-openapi.ts [--out <path>]`
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createApp } from "../packages/core/src/api/server.js";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--out");
  const out = resolve(i >= 0 ? (process.argv[i + 1] ?? "dist/openapi.json") : "dist/openapi.json");

  const app = createApp();
  const res = await app.handle(new Request("http://localhost/swagger/json"));
  if (!res.ok) throw new Error(`/swagger/json -> ${res.status}`);
  const doc = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };

  const pathCount = Object.keys(doc.paths ?? {}).length;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  console.log(`openapi:   ${doc.openapi} (${pathCount} paths)`);
  console.log(`written:   ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
