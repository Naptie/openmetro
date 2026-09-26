import { join } from 'node:path';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  type LineEncoded,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';

import { fareSpec } from './fares.js';
import { fetchChongqingSources } from './fetch.js';
import { normalizeChongqing } from './normalize.js';

export interface ChongqingNormalizeOptions {
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
}

export async function runChongqingNormalize(opts: ChongqingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-chongqing');

  const sources = await fetchChongqingSources();
  const canonical = normalizeChongqing(sources);

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
      city: '重庆',
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
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onOfficialMatch: () => officialMatched++,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });

  {
    const enFill = await fillStationEnglishNames(stations);
    stations = enFill.stations;
    console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  }
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
          source_id: t.source_id ?? 'cqmetro-routing-default'
        }
  );

  let segments = canonical.segments;
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables
    .map((t) => normalizeTimetableTimes(t))
    .filter((t) => {
      if (t.destination_stop_id && t.destination_stop_id === t.stop_id) return false;
      const ok = (a: readonly string[]) => a.length === 1 || a.length === 7;
      return ok(t.first_train) && ok(t.last_train);
    });

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
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 8, delay: 80 });
  }
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runChongqingNormalize({ skipFares: !process.argv.includes('--fares') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
