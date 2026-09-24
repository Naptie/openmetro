import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDerivedTimes,
  applyHarvestedTransferTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  type LineEncoded,
  type SegmentEncoded,
  type StationEncoded,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';

import { harvestSuzhouFares } from './fares.js';
import { fetchSuzhouSources } from './fetch.js';
import { normalize } from './normalize.js';
import {
  collectSuzhouOfficialTimes,
  SUZHOU_SEGMENT_SOURCE,
  type SuzhouSegmentMetric
} from './times.js';

/** Suzhou has no city-specific station corrections yet. */
export const transformStations: TransformStations = (stations) => stations;

export interface SuzhouNormalizeOptions {
  /** Repository root containing `data/cn-suzhou`. */
  root?: string;
  /** Unused — one-to-all fares are always harvested with the full sync. */
  skipFares?: boolean;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip official station-detail segment time harvest. */
  skipSegmentTimes?: boolean;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Overwrite non-source segments with official station-detail times + distances. */
function applyOfficialSegmentMetrics(
  segments: SegmentEncoded[],
  metrics: SuzhouSegmentMetric[]
): { segments: SegmentEncoded[]; applied: number } {
  const byPair = new Map<string, SuzhouSegmentMetric>();
  for (const m of metrics) {
    if (!(m.travel_time_seconds > 0)) continue;
    const key = pairKey(m.from_stop_id, m.to_stop_id);
    if (!byPair.has(key)) byPair.set(key, m);
  }
  let applied = 0;
  const out = segments.map((s) => {
    const hit = byPair.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!hit) return s;
    if (
      s.travel_time_source === 'source' &&
      s.travel_time_seconds === hit.travel_time_seconds &&
      s.distance_km === hit.distance_km
    ) {
      return s;
    }
    applied++;
    return {
      ...s,
      travel_time_seconds: hit.travel_time_seconds,
      travel_time_source: 'source' as const,
      travel_time_derived_from: undefined,
      distance_km: hit.distance_km ?? s.distance_km,
      source_id: SUZHOU_SEGMENT_SOURCE,
      extras: { ...(s.extras ?? {}), station_detail: true }
    };
  });
  return { segments: out, applied };
}

export async function runSuzhouNormalize(opts: SuzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-suzhou');

  const sources = await fetchSuzhouSources();
  const canonical = normalize(sources);

  // Official map already publishes `eName` (e.g. "Line 1"); names_source=source
  // tells core to keep them and skip Wikidata overwrite.
  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.name
  });

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '苏州',
      extraCities: ['昆山'],
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
      // Line 8「陆慕古巷」must not inherit Line 2「陆慕」coordinates.
      // Placed between 御窑 (120.6095,31.3623) and 阳澄湖中路 (120.6269,31.3668).
      knownLocations: [
        {
          name: '陆慕古巷',
          location: { lon: 120.6182, lat: 31.3645, crs: 'gcj02' },
          source: 'known'
        }
      ],
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
  } else {
    // Preserve previously geocoded locations + provenance on partial rebuilds.
    // `normalize()` rebuilds stations from the map JS and would otherwise drop
    // `extras.location_source`.
    try {
      const prev = JSON.parse(await readFile(join(outDir, 'stations.json'), 'utf-8')) as {
        records?: StationEncoded[];
      };
      const prevById = new Map((prev.records ?? []).map((s) => [s.id, s] as const));
      stations = canonical.stations.map((s) => {
        const old = prevById.get(s.id);
        if (!old?.location) return s;
        return {
          ...s,
          location: old.location,
          extras: {
            ...(s.extras ?? {}),
            // Only restore geocode provenance — never clobber freshly derived
            // identity fields (lines, planned_extension, map_corridor).
            location_source:
              (old.extras as { location_source?: string } | undefined)?.location_source ??
              (s.extras as { location_source?: string } | undefined)?.location_source
          }
        };
      });
    } catch {
      // no previous dataset
    }
  }
  stations = transformStations(stations, {
    network: canonical.network.id,
    city: '苏州'
  });

  const officialXfers = canonical.transfers
    .filter((t) => t.source_id && !String(t.source_id).startsWith('auto-xfer/'))
    .map((t) => ({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id,
      walk_time_seconds: t.walk_time_seconds,
      is_out_of_station: t.is_out_of_station,
      source_id: t.source_id
    }));

  let transfers = deriveTransfers(stations, canonical.stops, officialXfers, {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  let segments = applyDerivedTimes(canonical.segments, derived);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  // Official per-segment run times / distances from station detail API.
  if (!opts.skipSegmentTimes) {
    const officialTimes = await collectSuzhouOfficialTimes({
      stops: canonical.stops,
      patterns: canonical.patterns
    });
    const applied = applyOfficialSegmentMetrics(segments, officialTimes.segments);
    segments = applied.segments;
    // Remaining gaps: straight-line distance + speed-model times.
    segments = fillStraightLineDistances(segments, stations);
    segments = estimateTimesFromDistanceSpeed(segments);
    console.log(
      `  official segment metrics: detail=${officialTimes.fetchedDetailCount}, ` +
        `pairs=${officialTimes.pairedSegmentCount}, applied=${applied.applied}/${segments.length}`
    );
    // Documented 5-minute interchange average for unpublished walk times.
    const xfer = applyHarvestedTransferTimes(transfers, officialTimes.transfers);
    transfers = xfer.transfers;
    console.log(`  transfer walk fallback applied=${xfer.applied}/${transfers.length}`);
  }

  // Keep through-run / explicit official walk times; never clobber a harvested
  // fallback with an undefined official field.
  const officialByPair = new Map(
    officialXfers.map((t) => [`${t.from_line_id}|${t.to_line_id}|${t.station_id}`, t])
  );
  transfers = transfers.map((t) => {
    const match = officialByPair.get(`${t.from_line_id}|${t.to_line_id}|${t.station_id}`);
    if (!match || match.walk_time_seconds == null) return t;
    return {
      ...t,
      walk_time_seconds: match.walk_time_seconds,
      is_out_of_station: match.is_out_of_station ?? t.is_out_of_station,
      source_id: match.source_id ?? t.source_id,
      extras: match.source_id?.includes('through')
        ? { ...(t.extras ?? {}), through_run: true }
        : t.extras
    };
  });

  await writeCanonical(outDir, 'cn-suzhou', {
    network: canonical.network,
    lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables: canonical.timetables
  });

  // Always harvest: one-to-all is seconds, and verify requires fares.json.
  await harvestSuzhouFares(outDir);

  console.log('lines:', lines.length);
  console.log('stations:', stations.length);
  console.log('  operating:', stations.filter((s) => s.status === 'operating').length);
  console.log(
    '  under_construction:',
    stations.filter((s) => s.status === 'under_construction').length
  );
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via subway:', subwayMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via photon:', geocoded);
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
  const xferSrc: Record<string, number> = {};
  for (const t of transfers) {
    const k = t.source_id ?? 'none';
    xferSrc[k] = (xferSrc[k] ?? 0) + 1;
  }
  console.log('transfers by source_id:', xferSrc);
  console.log('through-run transfers:', transfers.filter((t) => t.walk_time_seconds === 0).length);
  console.log('timetables:', canonical.timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runSuzhouNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
