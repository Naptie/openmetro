/**
 * Export the generated OpenAPI document to `dist/openapi.json`.
 *
 * Uses the app's own `/swagger/json` route, so the published document can never
 * drift from the running server. The raw document is then normalized:
 *
 * - bare `$ref: "ApiLine"` values are rewritten to full JSON pointers
 *   (`#/components/schemas/ApiLine`) — most codegen toolchains (openapi-typescript
 *   among them) refuse to resolve bare names, while every referenced schema is
 *   emitted into `components.schemas` under its own `$id`.
 * - structural guards fail the export if the doc regresses: an empty
 *   `components.schemas` or a route without a 200 response schema is a bug.
 *
 * Usage:
 *   `bun run scripts/export-openapi.ts [--out <path>] [--check]`
 *
 * `--check` regenerates the document in memory and fails when it differs from
 * the existing file at `--out` (drift guard for CI: the committed
 * `dist/openapi.json` must match what the app generates).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ApiModels, normalizeOpenApiRefs } from '../packages/core/src/api/schema.js';
import { createApp } from '../packages/core/src/api/server.js';

type OpenApiDoc = {
  paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  components?: { schemas?: Record<string, unknown> };
};

/** Assert the doc is self-consistent; throws with a description otherwise. */
function assertHealthyDoc(doc: OpenApiDoc): void {
  const schemas = doc.components?.schemas;
  if (!schemas || Object.keys(schemas).length === 0) {
    throw new Error('components.schemas is empty — no named wire schemas were registered');
  }
  for (const name of Object.keys(ApiModels)) {
    if (!(name in schemas)) throw new Error(`components.schemas is missing "${name}"`);
  }
  const paths = doc.paths ?? {};
  if (Object.keys(paths).length === 0) throw new Error('document has no paths');
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const response = op.responses?.['200'];
      const content = (response as { content?: unknown } | undefined)?.content;
      const jsonContent = content as Record<string, { schema?: unknown }> | undefined;
      const schema = jsonContent?.['application/json']?.schema;
      if (!schema) {
        throw new Error(`${method.toUpperCase()} ${path} has no 200 response schema`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const i = process.argv.indexOf('--out');
  const out = resolve(i >= 0 ? (process.argv[i + 1] ?? 'dist/openapi.json') : 'dist/openapi.json');
  const check = args.has('--check');

  const app = createApp();
  const res = await app.handle(new Request('http://localhost/swagger/json'));
  if (!res.ok) throw new Error(`/swagger/json -> ${res.status}`);
  const raw = (await res.json()) as OpenApiDoc & { openapi?: string };

  normalizeOpenApiRefs(raw);
  assertHealthyDoc(raw);

  const json = `${JSON.stringify(raw, null, 2)}\n`;
  if (check) {
    const existing = await readFile(out, 'utf-8').catch(() => null);
    if (existing == null) throw new Error(`--check: ${out} does not exist — run the export first`);
    if (existing !== json) {
      throw new Error(`--check: ${out} is stale — re-run the export and commit the diff`);
    }
    console.log(
      `openapi:   ${raw.openapi} (${Object.keys(raw.paths ?? {}).length} paths) — up to date`
    );
    console.log(`checked:   ${out}`);
    return;
  }

  const pathCount = Object.keys(raw.paths ?? {}).length;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json, 'utf-8');
  console.log(`openapi:   ${raw.openapi} (${pathCount} paths)`);
  console.log(`written:   ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
