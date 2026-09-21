import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  fillCoordinates,
  fillMissingSegmentTimes,
  type LineEncoded,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { fetchHangzhouSources } from './fetch.js';
import { normalizeHangzhou } from './normalize.js';

export interface HangzhouNormalizeOptions {
  /** Repository root containing `data/cn-hangzhou`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip live OD fare harvest. */
  skipFares?: boolean;
}

function rootOfDefault(): string {
  if (process.env.OPENMETRO_ROOT) return process.env.OPENMETRO_ROOT;
  // Walk up from this package so `bun run normalize` from packages/adapters/*
  // still writes to the monorepo `data/` tree, not a nested package folder.
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

export async function runHangzhouNormalize(opts: HangzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? rootOfDefault();
  const outDir = join(root, 'data/cn-hangzhou');

  const sources = await fetchHangzhouSources();
  const canonical = normalizeHangzhou(sources);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '杭州',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      // LOO uses segment travel times (last_train-derived), not fares.
      speedValidate: true,
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
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'hzmetro-routing-default'
        }
  );

  let segments = canonical.segments;
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  console.log(
    `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
  );
  console.log(
    `  counts: lines=${lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables
  });
  console.log(`  wrote ${outDir}`);

  if (!opts.skipFares) {
    console.log('  harvest official OD fares');
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 12, delay: 80 });
  }

  console.log('lines:', lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via official/amap:', officialMatched);
  console.log('  via subway:', subwayMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via geocode:', geocoded);
  console.log('stops:', canonical.stops.length);
  console.log('patterns:', canonical.patterns.length);
  console.log('segments:', segments.length);
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('segments by time source:', bySrc);
  console.log('transfers:', transfers.length);
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runHangzhouNormalize({ skipFares: !process.argv.includes('--fares') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
