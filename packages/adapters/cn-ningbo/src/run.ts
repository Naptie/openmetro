import { join } from 'node:path';
import {
  applyDerivedTimes,
  computeNetworkQuality,
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
  loadBaiduAk,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';

import {
  harvestSegmentDistances,
  type NingboStationPoint,
  type SegmentPairQuery
} from './distances.js';
import { fareSpec } from './fares.js';
import { fetchNingboSources } from './fetch.js';
import { normalizeNingbo } from './normalize.js';

export interface NingboNormalizeOptions {
  /** Repository root containing `data/cn-ningbo`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip live OD fare harvest. */
  skipFares?: boolean;
  /** Skip the planner distance harvest. */
  skipDistances?: boolean;
}

/**
 * The adjacent stop pairs of the network, for the in-vehicle distance harvest.
 *
 * The pairs follow the canonical line order. A station with no coordinate in
 * any source cannot be queried and is left out.
 */
function segmentPairsForLine(canonical: {
  patterns: readonly { stop_ids: readonly string[] }[];
  stops: readonly { id: string; station_id: string }[];
  stations: readonly { id: string; name: string; location?: { lon: number; lat: number } }[];
}): SegmentPairQuery[] {
  const stopById = new Map(canonical.stops.map((s) => [s.id, s]));
  const stationById = new Map(canonical.stations.map((s) => [s.id, s]));
  const pointOf = (stationId: string): NingboStationPoint | undefined => {
    const station = stationById.get(stationId);
    if (!station?.location) return undefined;
    return { name: station.name, lon: station.location.lon, lat: station.location.lat };
  };
  const seen = new Set<string>();
  const out: SegmentPairQuery[] = [];
  for (const pattern of canonical.patterns) {
    const ids = pattern.stop_ids;
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i]!;
      const b = ids[i + 1]!;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const stopA = stopById.get(a);
      const stopB = stopById.get(b);
      if (!stopA || !stopB) continue;
      const from = pointOf(stopA.station_id);
      const to = pointOf(stopB.station_id);
      if (!from || !to) continue;
      out.push({ fromStopId: a, toStopId: b, from, to });
    }
  }
  return out;
}

/**
 * Write the planner's in-vehicle distance onto the segments on disk.
 *
 * The canonical write already put the haversine estimate in place, so the
 * measured distances are patched afterwards. `writeCanonical` computed the
 * quality block before the patch, so it is refreshed afterwards.
 */
async function applySegmentDistances(
  dataDir: string,
  metrics: readonly { fromStopId: string; toStopId: string; distanceMeters: number | null }[]
): Promise<number> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = join(dataDir, 'segments.json');
  const doc = JSON.parse(await readFile(path, 'utf8')) as {
    generated_at?: string;
    records: {
      from_stop_id: string;
      to_stop_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  const byPair = new Map(
    metrics.map((m) => [[m.fromStopId, m.toStopId].sort().join('|'), m] as const)
  );
  let applied = 0;
  for (const seg of doc.records) {
    const key = [seg.from_stop_id, seg.to_stop_id].sort().join('|');
    const meters = byPair.get(key)?.distanceMeters;
    if (!meters || meters <= 0) continue;
    seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
    seg.extras = {
      ...(seg.extras ?? {}),
      distance_source: 'baidu-transit-distance',
      distance_meters: Math.round(meters)
    };
    applied++;
  }
  doc.generated_at = new Date().toISOString();
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return applied;
}

/** Recompute `network.quality` from the final canonical files on disk. */
async function refreshQuality(dataDir: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const read = async (name: string) =>
    JSON.parse(await readFile(join(dataDir, name), 'utf8')) as { records: unknown[] };
  const readOptional = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(dataDir, name), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const network = JSON.parse(await readFile(join(dataDir, 'network.json'), 'utf8'));
  const quality = computeNetworkQuality({
    lines: (await read('lines.json')).records as never,
    stations: (await read('stations.json')).records as never,
    stops: (await read('stops.json')).records as never,
    segments: (await read('segments.json')).records as never,
    transfers: (await read('transfers.json')).records as never,
    timetables: (await read('timetables.json')).records as never,
    fares: (await readOptional('fares.json')) as never
  });
  await writeFile(
    join(dataDir, 'network.json'),
    `${JSON.stringify({ ...network, quality }, null, 2)}\n`,
    'utf8'
  );
}

export async function runNingboNormalize(opts: NingboNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-ningbo');

  const sources = await fetchNingboSources();
  const canonical = normalizeNingbo(sources);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  // Segment times first: the geocode chain validates coordinates against the
  // implied travel speed, so it needs the times to be present.
  let segments = canonical.segments;
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(stationsWithEn, {
      city: '宁波',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      segments: segments.map((s) => ({
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
  }

  // The canonical model treats a multi-line station as an interchange and
  // requires a complete directional pair set, so every published interchange
  // is emitted. Ningbo has no out-of-station interchanges — every published
  // interchange is inside one station — so the automatic cross-station rules
  // stay off. Stations the operator has not flagged as open yet carry the
  // caveat in `extras`.
  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: false
  })
    .filter((t) =>
      canonical.interchangePairs.has(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`)
    )
    .map((t) => {
      const base =
        t.walk_time_seconds != null
          ? t
          : {
              ...t,
              walk_time_seconds: defaultTransfer,
              source_id: t.source_id ?? 'nbmetro-routing-default'
            };
      if (!canonical.pendingInterchanges.has(t.station_id)) return base;
      return {
        ...base,
        extras: {
          ...(base.extras ?? {}),
          official_interchange_pending: true,
          official_note: '官网线路图标注「暂不能换乘」，该线首末班时刻尚未发布'
        }
      };
    });

  // Straight-line distance from coordinates + speed-model times for the gaps
  // (never overwrite source/planner/last_train values).
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
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

  // ---- Planner distances -----------------------------------------------------
  // The operator publishes no distances, so the in-vehicle distance of every
  // adjacent hop is measured with the Baidu planner. The canonical write
  // already put the straight-line estimate in place, so the measurements are
  // patched on afterwards.
  const baiduAk = loadBaiduAk();
  if (!opts.skipDistances && baiduAk) {
    const pairs = segmentPairsForLine(canonical);
    console.log(`  harvest ${pairs.length} in-vehicle segment distances via Baidu`);
    const metrics = await harvestSegmentDistances(baiduAk, pairs, {
      delayMs: 110,
      retries: 1,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) console.log(`    segment ${done}/${total}`);
      }
    });
    const withDistance = metrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(`    segment distances: ${withDistance}/${metrics.length}`);
    const applied = await applySegmentDistances(outDir, metrics);
    console.log(`    segment distances applied: ${applied}`);
    await refreshQuality(outDir);
  }

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
  console.log('transfers:', transfers.length);
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runNingboNormalize({ skipFares: !process.argv.includes('--fares') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
