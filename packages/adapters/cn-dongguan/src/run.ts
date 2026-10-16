import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  type FareMatrixEncoded,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  findRepoRoot,
  normalizeTimetableTimes,
  type SegmentEncoded,
  type TransferEncoded,
  writeCanonical
} from '@openmetro/core';
import { emptyFareMatrix, harvestFares } from './fares.js';
import { AMAP_URL, fetchDongguanSources } from './fetch.js';
import { NETWORK_ID, normalizeDongguan } from './normalize.js';

async function readPrevious<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

interface PreviousRecords<T> {
  records: T[];
  source: FareMatrixEncoded['source'];
}

const pairKey = (s: SegmentEncoded) => [s.from_stop_id, s.to_stop_id].sort().join('|');

export async function runDongguanNormalize(
  options: { root?: string; fares?: boolean } = {}
): Promise<void> {
  const outDir = join(options.root ?? findRepoRoot(), 'data', NETWORK_ID);
  const input = await fetchDongguanSources();
  const c = normalizeDongguan(input);
  const [previousSegments, previousTransfers, previousFares] = await Promise.all([
    readPrevious<PreviousRecords<SegmentEncoded>>(join(outDir, 'segments.json')),
    readPrevious<PreviousRecords<TransferEncoded>>(join(outDir, 'transfers.json')),
    readPrevious<FareMatrixEncoded>(join(outDir, 'fares.json'))
  ]);
  const timetables = c.timetables.map(normalizeTimetableTimes);
  const derived = deriveSegmentTimes(c.patterns, c.stops, timetables);
  const measured = new Map(
    (previousSegments?.records ?? [])
      .filter((s) => s.travel_time_source === 'planner' || s.travel_time_source === 'source')
      .map((s) => [pairKey(s), s])
  );
  let keptMeasurements = false;
  let segments = applyDerivedTimes(
    c.segments.map((s) => {
      const old = measured.get(pairKey(s));
      if (!old) return s;
      keptMeasurements = true;
      return {
        ...s,
        travel_time_seconds: old.travel_time_seconds,
        travel_time_source: old.travel_time_source,
        travel_time_derived_from: old.travel_time_derived_from,
        distance_km: old.extras?.distance_source === 'haversine' ? undefined : old.distance_km,
        extras: old.extras
      };
    }),
    derived
  );
  segments = fillStraightLineDistances(segments, c.stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, c.patterns, c.stops, timetables);
  const retainedTransfers = new Map(
    (previousTransfers?.records ?? [])
      .filter((t) => t.walk_time_seconds != null && !/default/.test(t.source_id ?? ''))
      .map((t) => [t.id, t])
  );
  const transfers = deriveTransfers(c.stations, c.stops, [...retainedTransfers.values()], {
    patterns: c.patterns,
    lines: c.lines,
    routing: c.network.routing,
    crossStation: false
  }).map((t) => ({ ...retainedTransfers.get(t.id), ...t }));

  // Reindex retained fares even for timetable-only syncs, which also refresh topology.
  let fares = options.fares
    ? await harvestFares(c.stations, previousFares)
    : emptyFareMatrix(c.stations);
  if (!options.fares && previousFares) {
    const oldIndex = new Map(previousFares.station_ids.map((id, i) => [id, i]));
    fares = {
      ...fares,
      fares: fares.station_ids.map((a, i) =>
        fares.station_ids.map((b, j) => {
          if (i === j) return 0;
          const ai = oldIndex.get(a),
            bi = oldIndex.get(b);
          return ai == null || bi == null ? null : (previousFares.fares[ai]?.[bi] ?? null);
        })
      ),
      source: previousFares.source,
      generated_at: previousFares.generated_at
    };
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
    const retainedSources =
      entity === 'segments' && keptMeasurements
        ? (previousSegments?.source ?? [])
        : entity === 'transfers' && transfers.some((t) => t.walk_time_seconds != null)
          ? (previousTransfers?.source ?? [])
          : [];
    doc.source = [
      ...sources,
      ...retainedSources.filter((s) => !sources.some((n) => n.name === s.name))
    ];
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
