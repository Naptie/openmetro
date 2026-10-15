import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  findRepoRoot,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { emptyFareMatrix, harvestFares } from './fares.js';
import { AMAP_URL, fetchDongguanSources } from './fetch.js';
import { NETWORK_ID, normalizeDongguan } from './normalize.js';

export async function runDongguanNormalize(
  options: { root?: string; fares?: boolean } = {}
): Promise<void> {
  const outDir = join(options.root ?? findRepoRoot(), 'data', NETWORK_ID);
  const input = await fetchDongguanSources();
  const c = normalizeDongguan(input);
  const timetables = c.timetables.map(normalizeTimetableTimes);
  const derived = deriveSegmentTimes(c.patterns, c.stops, timetables);
  let segments = applyDerivedTimes(c.segments, derived);
  segments = fillStraightLineDistances(segments, c.stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, c.patterns, c.stops, timetables);
  const transfers = deriveTransfers(c.stations, c.stops, [], {
    patterns: c.patterns,
    lines: c.lines,
    routing: c.network.routing,
    crossStation: false
  });

  let fares = options.fares ? await harvestFares(c.stations) : undefined;
  if (!fares) {
    try {
      await readFile(join(outDir, 'fares.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // New topology-only networks must still ship a square fare matrix.
      fares = emptyFareMatrix(c.stations);
    }
  }
  await writeCanonical(outDir, NETWORK_ID, { ...c, segments, transfers, timetables, fares });
  const retrievedAt = new Date().toISOString();
  const source = (name: string, url: string, attribution: string) => ({
    name,
    url,
    version: 'live',
    retrieved_at: retrievedAt,
    license: 'unknown',
    license_url: null,
    attribution
  });
  const sources = [
    source('dggdjt-service-times', input.timetableUrl, '东莞市轨道交通有限公司'),
    source('amap-subway-4419', AMAP_URL, '高德地图')
  ];
  for (const entity of [
    'lines',
    'stations',
    'stops',
    'patterns',
    'segments',
    'transfers',
    'timetables'
  ]) {
    const path = join(outDir, `${entity}.json`);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    doc.source = sources;
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(
    `  wrote ${c.lines.length} lines, ${c.stations.length} stations, ${c.stops.length} stops, ${segments.length} segments, ${transfers.length} transfers, ${timetables.length} timetables`
  );
}

if (import.meta.main) {
  runDongguanNormalize({ fares: process.argv.includes('--fares') }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
