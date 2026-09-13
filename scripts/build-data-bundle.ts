/**
 * Stage the canonical dataset under `dist/data/` for release packaging.
 *
 * Usage: `bun run scripts/build-data-bundle.ts [--out <dir>]`
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DATA_ROOT = resolve(process.env.OPENMETRO_DATA_ROOT ?? 'data');

const CANONICAL_FILES = [
  'network.json',
  'lines.json',
  'stations.json',
  'stops.json',
  'patterns.json',
  'segments.json',
  'transfers.json',
  'timetables.json',
  'fares.json'
];

async function main(): Promise<void> {
  const i = process.argv.indexOf('--out');
  const outRoot = resolve(i >= 0 ? (process.argv[i + 1] ?? 'dist/data') : 'dist/data');

  const ids = (await readdir(DATA_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  const networks: string[] = [];
  for (const id of ids) {
    const src = join(DATA_ROOT, id);
    const dest = join(outRoot, id);
    await mkdir(dest, { recursive: true });
    let copied = 0;
    for (const file of CANONICAL_FILES) {
      const from = join(src, file);
      const raw = await readFile(from).catch(() => null);
      if (!raw) continue;
      await writeFile(join(dest, file), raw);
      copied++;
    }
    if (copied > 0) networks.push(id);
  }

  // Ship the content-addressed manifest alongside the data when present.
  const manifest = await readFile(resolve('dist/data-manifest.json')).catch(() => null);
  if (manifest) await writeFile(join(outRoot, 'manifest.json'), manifest);

  await writeFile(
    join(outRoot, 'README.md'),
    [
      '# Open Metro data',
      '',
      'Canonical metro network data (lines, stations, stops, patterns, segments,',
      'transfers, timetables). See `manifest.json` for per-file sha256 checksums',
      'and the `aggregate` content hash.',
      '',
      `Networks: ${networks.join(', ')}`,
      ''
    ].join('\n'),
    'utf-8'
  );

  console.log(`data bundle: ${outRoot} (${networks.join(', ')})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
