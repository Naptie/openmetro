import { join } from 'node:path';
import {
  applyCityMetadata,
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  findRepoRoot,
  type LineEncoded,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { fetchMlmSources } from './fetch.js';
import { normalizeMacau } from './normalize.js';

export interface MacauNormalizeOptions {
  root?: string;
}

export async function runMacauNormalize(opts: MacauNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-macau');

  const sources = await fetchMlmSources();
  const canonical = normalizeMacau(sources);

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(canonical.stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l: LineEncoded) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'mlm-transfer-default'
        }
  );

  // Segment times: last-train chain → straight-line distance → speed estimate
  // → network default (same pipeline as cn-hongkong).
  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, timetables, {});
  let segments = applyDerivedTimes(canonical.segments, derived);
  segments = fillStraightLineDistances(segments, canonical.stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, canonical.patterns, canonical.stops, timetables);

  console.log(
    `  counts: lines=${canonical.lines.length} stations=${canonical.stations.length} ` +
      `stops=${canonical.stops.length} patterns=${canonical.patterns.length} ` +
      `segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('  segments by time source:', bySrc);

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines: canonical.lines,
    stations: canonical.stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables,
    fares: canonical.fares
  });
  console.log(`  wrote ${outDir}`);

  // City metadata always comes from worldwide-regions (same as scripts/sync.ts).
  // Adapters only declare `openmetro.cityId` in package.json.
  const cities = await applyCityMetadata({ root, networks: ['cn-macau'] });
  for (const u of cities.updated) {
    console.log(`  [${u.networkId}] city <- ${u.cityId} (country ${u.country})`);
  }
  if (cities.updated.length === 0) console.log(`  city metadata already up to date`);

  const withCoords = canonical.stations.filter((s) => s.location).length;
  console.log(`  stations with coords: ${withCoords}/${canonical.stations.length}`);
  const fareCells = canonical.fares.fares.flat().filter((v) => v != null && v > 0).length;
  console.log(`  fare cells (off-diagonal filled): ${fareCells}`);
  const ttWithTimes = timetables.filter(
    (t) => t.first_train.length > 0 && t.last_train.length > 0
  ).length;
  console.log(`  timetables with first+last: ${ttWithTimes}/${timetables.length}`);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runMacauNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
