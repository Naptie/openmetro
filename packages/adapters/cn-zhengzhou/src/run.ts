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
import { fetchZhengzhouSources } from './fetch.js';
import { normalizeZhengzhou } from './normalize.js';
import { applyZhengzhouSegmentMetrics, collectZhengzhouSegmentMetrics } from './times.js';

export interface ZhengzhouNormalizeOptions {
  /** Repository root containing `data/cn-zhengzhou`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip live OD fare harvest. */
  skipFares?: boolean;
  /** Skip official planner segment-time harvest. */
  skipSegmentTimes?: boolean;
}

export async function runZhengzhouNormalize(opts: ZhengzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-zhengzhou');

  const sources = await fetchZhengzhouSources();
  const canonical = normalizeZhengzhou(sources);

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
      city: '郑州',
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
          source_id: t.source_id ?? 'zzmetro-routing-default'
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

  if (!opts.skipSegmentTimes) {
    const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
    const zidOf = (stopId: string): string | undefined => {
      const s = stopById.get(stopId);
      if (s?.source_id) return s.source_id;
      const codes = (s?.extras as { official_zids?: string[] } | undefined)?.official_zids;
      return codes?.[0];
    };
    const harvest = await collectZhengzhouSegmentMetrics({
      stops: canonical.stops,
      patterns: canonical.patterns,
      zidOf,
      concurrency: 6,
      delayMs: 50
    });
    const applied = applyZhengzhouSegmentMetrics(segments, harvest.segments);
    segments = applied.segments;
    console.log(
      `  official segment metrics: fetched=${harvest.fetched} failed=${harvest.failed} applied=${applied.applied}/${segments.length}`
    );
    // Gaps keep straight-line distance + speed-model times.
    segments = fillStraightLineDistances(segments, stations);
    segments = estimateTimesFromDistanceSpeed(segments);
    segments = fillMissingSegmentTimes(
      segments,
      canonical.patterns,
      canonical.stops,
      canonical.timetables
    );
  }

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
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 8, delay: 80 });
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
  console.log('segments with distance_km:', segments.filter((s) => s.distance_km != null).length);
  console.log('transfers:', transfers.length);
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runZhengzhouNormalize({ skipFares: !process.argv.includes('--fares') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
