/**
 * Export JSON Schemas derived from the Effect schemas in
 * `packages/core/src/schema/` to `schemas/v1/`.
 *
 * These files are the published `$schema` targets referenced by every canonical
 * data file. They are generated, never hand-written — edit the Effect schemas
 * and re-run this script.
 *
 * Usage: `bun run scripts/export-json-schemas.ts [--out <dir>]`
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JSONSchema } from 'effect';
import { DataFile } from '../packages/core/src/schema/file.js';
import {
  FareMatrix,
  Line,
  Network,
  Pattern,
  Segment,
  Station,
  Stop,
  Timetable,
  Transfer
} from '../packages/core/src/schema/index.js';

/** Document-type → schema. Entity wrappers share the DataFile envelope. */
const DOCUMENTS: Record<string, unknown> = {
  lines: DataFile(Line),
  stations: DataFile(Station),
  stops: DataFile(Stop),
  patterns: DataFile(Pattern),
  segments: DataFile(Segment),
  transfers: DataFile(Transfer),
  timetables: DataFile(Timetable),
  fares: FareMatrix,
  network: Network
};

async function main(): Promise<void> {
  const i = process.argv.indexOf('--out');
  const outDir = resolve(i >= 0 ? (process.argv[i + 1] ?? 'schemas/v1') : 'schemas/v1');

  await mkdir(outDir, { recursive: true });
  for (const [name, schema] of Object.entries(DOCUMENTS)) {
    const json = JSONSchema.make(schema as Parameters<typeof JSONSchema.make>[0]);
    const file = join(outDir, `${name}.schema.json`);
    await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    console.log(`wrote ${file}`);
  }

  // Keep published schemas Biome-clean so `bun run lint` stays green.
  const fmt = spawnSync('bunx', ['biome', 'format', '--write', outDir], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (fmt.status !== 0) {
    throw new Error(`biome format failed (exit ${fmt.status})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
