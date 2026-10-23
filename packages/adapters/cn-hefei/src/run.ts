/**
 * Sync pipeline for cn-hefei.
 *
 * ```
 * fetchHefeiSources()
 *   → normalizeHefei()                       # lines/stations/stops/patterns/segments/network
 *   → harvestStationTimetables() × 8         # Baidu per-station first/last
 *   → normalizeHefei() (again, with times)   # the ids are deterministic
 *   → fillStationEnglishNames()
 *   → fillCoordinates()                       # AMap → Overpass → Photon cascade
 *   → deriveTransfers()
 *   → normalizeTimetableTimes()
 *   → deriveSegmentTimes() / applyDerivedTimes()
 *   → fillStraightLineDistances() / estimateTimesFromDistanceSpeed() / fillMissingSegmentTimes()
 *   → writeCanonical(outDir, …)
 * ```
 *
 * The first pass is a pure topology pass; the timetable harvest needs the
 * station ids and coordinates, so it runs between two normalizations. Both
 * normalizations derive the same ids from the same sources, so the second one
 * is deterministic.
 */
import { join } from 'node:path';
import {
  applyDerivedTimes,
  computeNetworkQuality,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  loadBaiduAk,
  normalizeTimetableTimes,
  type SegmentEncoded,
  type StationEncoded,
  writeCanonical
} from '@openmetro/core';
import {
  type HefeiStationPoint,
  harvestSegmentDistances,
  type SegmentPairQuery
} from './distances.js';
import { computeAndWriteFares } from './fares.js';
import { fetchHefeiSources, type HefeiSources } from './fetch.js';
import { HEFEI_LINES, type HefeiLineConfig } from './lines.js';
import { type HefeiCanonical, normalizeHefei } from './normalize.js';
import {
  type HarvestedStationTimes,
  type HefeiStationRef,
  harvestStationTimetables,
  serviceBandFor
} from './timetables.js';

export interface HefeiNormalizeOptions {
  /** Repository root containing `data/cn-hefei`. */
  root?: string;
  /** Skip the geocoding cascade (dev runs). */
  skipGeocode?: boolean;
  /** Skip the Baidu per-station first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu in-vehicle distance harvest (dev runs). */
  skipDistances?: boolean;
  /** Skip the official fare matrix. */
  skipFares?: boolean;
}

/**
 * The planner references for one line, in canonical order.
 *
 * The not-yet-open stations have no coordinate in any source, so they cannot
 * be queried and are left out.
 */
function refsForLine(canonical: HefeiCanonical, cfg: HefeiLineConfig): HefeiStationRef[] {
  const lineId = `cn-hefei-line-${cfg.slug}`;
  const stops = canonical.stopsByLineId.get(lineId) ?? [];
  const refs: HefeiStationRef[] = [];
  for (const stop of stops) {
    const station = canonical.stations.find((s) => s.id === stop.station_id);
    if (!station?.location) continue;
    refs.push({
      name: station.name,
      lon: station.location.lon,
      lat: station.location.lat
    });
  }
  return refs;
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
  console.log('  refreshed network.quality');
}

/**
 * The AMap subway dataset, re-keyed onto the canonical station names.
 *
 * The AMap dataset is injected into the geocoding cascade rather than letting
 * core fetch it again, so the 195 canonical names resolve in one lookup and
 * the cascade never has to fall through to Overpass or Photon.
 */
function subwayStations(canonical: HefeiCanonical) {
  const out: {
    name: string;
    pinyin?: string;
    poiid?: string;
    location: { lon: number; lat: number; crs: 'gcj02' };
  }[] = [];
  for (const station of canonical.stations) {
    if (!station.location) continue;
    out.push({
      name: station.name,
      pinyin: station.extras?.pinyin as string | undefined,
      poiid: (station.extras?.amap_poiid as string | undefined) ?? undefined,
      location: {
        lon: station.location.lon,
        lat: station.location.lat,
        crs: 'gcj02'
      }
    });
  }
  return out;
}

/**
 * The adjacent stop pairs of one line, for the in-vehicle distance harvest.
 *
 * The pairs follow the canonical line order; the not-yet-open stations have no
 * coordinate in any source, so they cannot be queried and are left out.
 */
function segmentPairsForLine(canonical: HefeiCanonical, cfg: HefeiLineConfig): SegmentPairQuery[] {
  const lineId = `cn-hefei-line-${cfg.slug}`;
  const stops = canonical.stopsByLineId.get(lineId) ?? [];
  const pointOf = (stationId: string): HefeiStationPoint | undefined => {
    const station = canonical.stations.find((s) => s.id === stationId);
    if (!station?.location) return undefined;
    return { name: station.name, lon: station.location.lon, lat: station.location.lat };
  };
  const out: SegmentPairQuery[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const from = pointOf(a.station_id);
    const to = pointOf(b.station_id);
    if (!from || !to) continue;
    out.push({ line: cfg, fromStopId: a.id, toStopId: b.id, from, to });
  }
  return out;
}

/**
 * Write the planner's in-vehicle distance onto the segments on disk.
 *
 * The canonical write already put the haversine estimate in place, so the
 * measured distances are patched afterwards — the same way cn-dalian and
 * cn-nanchang do it. `writeCanonical` computed the quality block before the
 * patch, so it is refreshed afterwards.
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

export async function runHefeiNormalize(opts: HefeiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-hefei');

  const sources: HefeiSources = await fetchHefeiSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — the operator publishes first/last trains only for the ' +
        "lines' first-train origin and last-train terminals, so every intermediate station's " +
        'window is harvested from the Baidu planner.'
    );
  }

  // ---- First pass: topology --------------------------------------------------
  const provisional = normalizeHefei({ sources });
  console.log(
    `  topology: lines=${provisional.lines.length} stations=${provisional.stations.length} ` +
      `stops=${provisional.stops.length} patterns=${provisional.patterns.length} ` +
      `segments=${provisional.segments.length}`
  );
  if (provisional.notYetOpen.length > 0) {
    console.log(
      `  not yet open (official network map): ${provisional.notYetOpen
        .map((s) => `${s.name} (${s.line})`)
        .join(', ')}`
    );
  }

  // ---- Per-station first/last trains ----------------------------------------
  const harvested = new Map<string, HarvestedStationTimes[]>();
  const band = serviceBandFor(new Date());
  if (!opts.skipTimetables && baiduAk) {
    console.log(`  harvest per-station first/last trains via Baidu (service band: ${band})`);
    for (const cfg of HEFEI_LINES) {
      const refs = refsForLine(provisional, cfg);
      if (refs.length < 2) {
        console.log(`    ${cfg.name}: skip (no coordinates)`);
        continue;
      }
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, {
        delayMs: 110,
        retries: 1
      });
      const withTimes = rows.filter(
        (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
      ).length;
      console.log(`    ${cfg.name}: ${withTimes}/${rows.length} stations with times`);
      harvested.set(cfg.officialId, rows);
    }
  }

  // ---- Second pass: canonical records with the harvested times --------------
  const canonical = normalizeHefei({ sources, harvestedTimes: harvested, serviceBand: band });

  // ---- English names --------------------------------------------------------
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations: StationEncoded[] = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  const withoutEnglish = stations.filter((s) => !s.names.en.trim()).length;
  if (withoutEnglish > 0) {
    console.log(`  stations without an English name: ${withoutEnglish}`);
  }

  // ---- Coordinates ----------------------------------------------------------
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '合肥',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      fetchers: { fetchSubway: async () => subwayStations(canonical) },
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    for (let i = 0; i < located.length; i++) stations[i] = located[i]!;
  }
  console.log(`  geocode: subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`);

  // ---- Transfers ------------------------------------------------------------
  // The operator publishes no transfer walk times, so the edges carry none
  // here; the core `gapfill` layer measures them with the Baidu planner.
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // ---- Segment times --------------------------------------------------------
  let segments: SegmentEncoded[] = canonical.segments;
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

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  console.log(
    `  counts: lines=${canonical.lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines: canonical.lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables
  });
  console.log(`  wrote ${outDir}`);

  // ---- Planner distances ----------------------------------------------------
  // The official tariff is a distance ladder and the operator publishes no
  // distances, so the in-vehicle distance of every adjacent hop is measured
  // with the planner. The measured value replaces the haversine estimate the
  // canonical write put in place.
  if (!opts.skipDistances && baiduAk) {
    const pairs = HEFEI_LINES.flatMap((cfg) => segmentPairsForLine(canonical, cfg));
    console.log(`  harvest ${pairs.length} in-vehicle segment distances via Baidu`);
    const metrics = await harvestSegmentDistances(baiduAk, pairs, { delayMs: 110, retries: 1 });
    const withDistance = metrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(`    segment distances: ${withDistance}/${metrics.length}`);
    const applied = await applySegmentDistances(outDir, metrics);
    console.log(`    segment distances applied: ${applied}`);
    await refreshQuality(outDir);
  }

  // ---- Fares ----------------------------------------------------------------
  if (!opts.skipFares) {
    console.log('  compute official fare matrix (distance ladder)');
    await computeAndWriteFares(outDir);
    await refreshQuality(outDir);
  }

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('  operating:', stations.filter((s) => s.status === 'operating').length);
  console.log(
    '  under_construction:',
    stations.filter((s) => s.status === 'under_construction').length
  );
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('with English names:', stations.filter((s) => s.names.en.trim()).length);
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
  runHefeiNormalize({
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipDistances: process.argv.includes('--skip-distances'),
    skipGeocode: process.argv.includes('--skip-geocode'),
    skipFares: process.argv.includes('--skip-fares')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
