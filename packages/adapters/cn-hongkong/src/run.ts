import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  type LineEncoded,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { fetchMtrSources } from './fetch.js';
import { normalizeHongKong } from './normalize.js';

export interface HongKongNormalizeOptions {
  /** Repository root containing `data/cn-hongkong`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Unused — fares come from published CSVs and are always written. */
  skipFares?: boolean;
}

function rootOfDefault(): string {
  if (process.env.OPENMETRO_ROOT) return process.env.OPENMETRO_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'packages', 'adapters')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

export async function runHongKongNormalize(opts: HongKongNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? rootOfDefault();
  const outDir = join(root, 'data/cn-hongkong');

  const sources = await fetchMtrSources();
  const canonical = normalizeHongKong(sources);

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    // Official MTR feed publishes no coordinates. Seed AMap GCJ-02 by English
    // name (MTR traditional vs AMap simplified Chinese would miss otherwise),
    // then fall through to Overpass/Photon for gaps.
    stations = await fillCoordinates(canonical.stations, {
      city: '香港',
      stops: canonical.stops,
      lines: canonical.lines.map((l: LineEncoded) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      failOnInvalidCoordinates: false,
      onOfficialMatch: () => officialMatched++,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
  }

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(stations, canonical.stops, [], {
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
          source_id: t.source_id ?? 'mtr-routing-default'
        }
  );

  // Official journey-time pages are not published. Pipeline:
  //  1) last-train chain → per-segment times
  //  2) straight-line distance from station coordinates
  //  3) remaining times from line/network affine distance-time fits
  //  4) only then the flat network default
  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, timetables, {});
  let segments = applyDerivedTimes(canonical.segments, derived);
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, canonical.patterns, canonical.stops, timetables);

  console.log(
    `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
  );
  console.log(
    `  counts: lines=${canonical.lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines: canonical.lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables,
    fares: canonical.fares
  });
  console.log(`  wrote ${outDir}`);

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('stops:', canonical.stops.length);
  console.log('patterns:', canonical.patterns.length);
  console.log('segments:', segments.length);
  console.log('transfers:', transfers.length);
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('segments by time source:', bySrc);
  console.log('segments with distance:', segments.filter((s) => s.distance_km != null).length);
  console.log(
    'segments with haversine distance:',
    segments.filter((s) => s.extras?.distance_source === 'haversine').length
  );
  const filled = canonical.fares.fares.flat().filter((v) => v != null && v > 0).length;
  console.log('fare cells (off-diagonal filled):', filled);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runHongKongNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
