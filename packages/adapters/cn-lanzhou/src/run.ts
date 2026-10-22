import { join } from 'node:path';
import {
  applyDerivedTimes,
  applyHarvestedSegmentTimes,
  type BaiduStationRef,
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
import { buildLanzhouFareMatrix, verifyFareMatrixAgainstTariff } from './fares.js';
import { fetchLanzhouSources, type LanzhouSources } from './fetch.js';
import type { LanzhouLineConfig } from './lines.js';
import { LANZHOU_LINES, LINE_CONFIG_BY_OFFICIAL_ID, lanzhouMileageFare } from './lines.js';
import { foldLanzhouStationName, type LanzhouCanonical, normalizeLanzhou } from './normalize.js';
import { harvestSegmentMetrics, type SegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestStationTimetables } from './timetables.js';

export interface LanzhouNormalizeOptions {
  /** Repository root containing `data/cn-lanzhou`. */
  root?: string;
  skipGeocode?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu adjacent-pair segment metric harvest (dev runs). */
  skipSegmentMetrics?: boolean;
}

/**
 * English labels that carry no information.
 *
 * Wikidata returns the generic `Station` label for most Lanzhou stations (22
 * of 27) and, for 奥体中心, a same-named **Chongqing** station. The adapter
 * therefore romanises the AMap pinyin instead; this filter only guards the
 * Wikidata fallback for a station AMap does not cover.
 */
const GENERIC_EN = /^(station|metro station|subway station|车站|地铁站)$/i;

/** AMap GCJ-02 coordinates keyed by the folded station name. */
function amapCoordsByFold(sources: LanzhouSources): Map<string, { lon: number; lat: number }> {
  const out = new Map<string, { lon: number; lat: number }>();
  for (const line of sources.amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.set(foldLanzhouStationName(n), { lon, lat });
    }
  }
  return out;
}

/**
 * Planner station refs for one line, in the operator's official line order.
 *
 * The order comes from the operator's `serve.js` literal; only the
 * coordinates are borrowed from AMap.
 */
function refsForLine(
  sources: LanzhouSources,
  officialId: string,
  coordsByFold: Map<string, { lon: number; lat: number }>
): BaiduStationRef[] {
  const official = sources.officialLines.find((l) => l.value === officialId);
  if (!official) return [];
  const refs: BaiduStationRef[] = [];
  for (const name of official.lines) {
    const coord = coordsByFold.get(foldLanzhouStationName(name));
    if (!coord) continue;
    refs.push({ name, lon: coord.lon, lat: coord.lat });
  }
  return refs;
}

/**
 * Fill in English names, but never with a label that says nothing.
 *
 * The adapter's own romanisation (AMap pinyin) is already in `names.en` for
 * every station AMap covers, so Wikidata is only consulted for the rest — and
 * a generic `Station` answer is dropped rather than published.
 */
function sanitizeEnglishNames(
  original: StationEncoded[],
  filled: StationEncoded[]
): StationEncoded[] {
  const byId = new Map(original.map((s) => [s.id, s] as const));
  return filled.map((s) => {
    if (!GENERIC_EN.test(s.names.en.trim())) return s;
    const prior = byId.get(s.id);
    if (prior?.names.en.trim()) return prior;
    return { ...s, names: { ...s.names, en: '' } };
  });
}

/**
 * One planner query per undirected adjacent stop pair, measuring the rail
 * leg's in-vehicle duration and distance.
 *
 * The pair list follows the patterns, so a physical pair shared by two lines
 * would be queried once.
 */
async function harvestAdjacentSegmentMetrics(
  ak: string | null,
  canonical: LanzhouCanonical,
  stations: StationEncoded[],
  skip: boolean | undefined
): Promise<SegmentMetrics[]> {
  if (skip || !ak) return [];
  const stationById = new Map(stations.map((s) => [s.id, s] as const));
  const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
  const cfgByLineId = new Map<string, LanzhouLineConfig>(
    LANZHOU_LINES.map((c) => [`cn-lanzhou-line-${c.slug}`, c] as const)
  );

  const queries: SegmentPairQuery[] = [];
  const seen = new Set<string>();
  for (const pattern of canonical.patterns) {
    const cfg = cfgByLineId.get(pattern.line_id);
    if (!cfg) continue;
    for (let i = 0; i + 1 < pattern.stop_ids.length; i++) {
      const a = stopById.get(pattern.stop_ids[i]!);
      const b = stopById.get(pattern.stop_ids[i + 1]!);
      if (!a || !b) continue;
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const sa = stationById.get(a.station_id);
      const sb = stationById.get(b.station_id);
      if (!sa?.location || !sb?.location) continue;
      queries.push({
        line: cfg,
        fromStopId: a.id,
        toStopId: b.id,
        from: { name: sa.name, lon: sa.location.lon, lat: sa.location.lat },
        to: { name: sb.name, lon: sb.location.lon, lat: sb.location.lat }
      });
    }
  }

  console.log(`  harvest ${queries.length} adjacent-pair segment metrics via Baidu Direction v2`);
  const metrics = await harvestSegmentMetrics(ak, queries, { delayMs: 300, retries: 1 });
  const withDuration = metrics.filter((m) => (m.durationSeconds ?? 0) > 0).length;
  const withDistance = metrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
  console.log(
    `  segment metrics: ${withDuration}/${metrics.length} durations, ${withDistance}/${metrics.length} distances`
  );
  return metrics;
}

/**
 * Apply the planner's in-vehicle time to the segments.
 *
 * `applyHarvestedSegmentTimes` keeps official values and tags the rest
 * `planner`.
 */
function applySegmentTimes(
  segments: SegmentEncoded[],
  metrics: readonly SegmentMetrics[]
): SegmentEncoded[] {
  return applyHarvestedSegmentTimes(
    segments,
    metrics
      .filter((m) => (m.durationSeconds ?? 0) > 0)
      .map((m) => ({
        from_stop_id: m.fromStopId,
        to_stop_id: m.toStopId,
        travel_time_seconds: m.durationSeconds!,
        source_id: 'baidu-transit'
      }))
  ).segments;
}

/** Write the planner's in-vehicle distance onto the segments on disk. */
async function applySegmentDistances(
  dataDir: string,
  metrics: readonly SegmentMetrics[]
): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const segmentsPath = join(dataDir, 'segments.json');
  const doc = JSON.parse(await readFile(segmentsPath, 'utf-8')) as {
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
    if (meters == null || meters <= 0) continue;
    seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
    seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
    applied++;
  }
  doc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  console.log(`  segment distances applied: ${applied} planner`);
}

/** Recompute `network.quality` from the final canonical files on disk. */
async function refreshQuality(dataDir: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { computeNetworkQuality } = await import('@openmetro/core');
  const read = async (name: string) => JSON.parse(await readFile(join(dataDir, name), 'utf-8'));
  const readOptional = async (name: string) => {
    try {
      return await read(name);
    } catch {
      return undefined;
    }
  };
  const network = await read('network.json');
  const quality = computeNetworkQuality({
    lines: (await read('lines.json')).records,
    stations: (await read('stations.json')).records,
    stops: (await read('stops.json')).records,
    segments: (await read('segments.json')).records,
    transfers: (await read('transfers.json')).records,
    timetables: (await read('timetables.json')).records,
    fares: await readOptional('fares.json')
  });
  await writeFile(
    join(dataDir, 'network.json'),
    `${JSON.stringify({ ...network, quality }, null, 2)}\n`,
    'utf-8'
  );
  console.log('  refreshed network.quality');
}

export async function runLanzhouNormalize(opts: LanzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-lanzhou');

  const sources = await fetchLanzhouSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Lanzhou per-station first/last trains are harvested via Baidu Direction v2 (the operator publishes its timetable sheets only as static images; no OCR).'
    );
  }

  const coordsByFold = amapCoordsByFold(sources);

  // ---- First/last trains, per line -----------------------------------------
  const harvestedTimes = new Map<string, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  if (!opts.skipTimetables && baiduAk) {
    for (const official of sources.officialLines) {
      const cfg = LINE_CONFIG_BY_OFFICIAL_ID.get(official.value);
      if (!cfg) continue;
      const refs = refsForLine(sources, official.value, coordsByFold);
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no AMap coordinates)`);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 300, retries: 1 });
      const withTimes = rows.filter(
        (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
      ).length;
      if (withTimes < Math.ceil(refs.length * 0.8)) {
        throw new Error(
          `${cfg.short}: Baidu harvest covered only ${withTimes}/${refs.length} stations with times — refusing to write partial timetables`
        );
      }
      // Every station needs both directions (the terminus of a direction has
      // no service in it). A gap is a planner routing hole, not a data
      // condition, so it is reported rather than silently published.
      const gaps: string[] = [];
      rows.forEach((row, i) => {
        const isFirst = i === 0;
        const isLast = i === rows.length - 1;
        if (!isLast && !(row.downFirst && row.downLast)) {
          gaps.push(`${row.stationName}→down`);
        }
        if (!isFirst && !(row.upFirst && row.upLast)) {
          gaps.push(`${row.stationName}→up`);
        }
      });
      if (gaps.length > 0) {
        console.log(
          `    ${cfg.short}: ${gaps.length} direction(s) without times: ${gaps.join(', ')}`
        );
      }
      console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
      harvestedTimes.set(official.value, rows);
    }
  }

  const canonical = normalizeLanzhou({ sources, harvestedTimes });

  // ---- English names --------------------------------------------------------
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations = sanitizeEnglishNames(canonical.stations, enFill.stations);
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  const withoutEnglish = stations.filter((s) => !s.names.en.trim()).length;
  if (withoutEnglish > 0) {
    console.log(`  stations without an English name: ${withoutEnglish}`);
  }

  // ---- Coordinates ----------------------------------------------------------
  // The operator publishes no coordinates, so the AMap Subway dataset is the
  // source. `fillCoordinates` re-resolves them through the standard cascade
  // (AMap → Overpass → Photon) and records the provenance per station.
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '兰州',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    for (let i = 0; i < located.length; i++) stations[i] = located[i]!;
  }

  // ---- Transfers ------------------------------------------------------------
  // The operator publishes no transfer walk times, so every transfer edge
  // falls back to the network's own `default_transfer_seconds`.
  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'lanzhou-routing-default'
        }
  );

  // ---- Segment times --------------------------------------------------------
  // The operator publishes no per-segment run times. They are measured on the
  // planner (one query per adjacent pair) and fall back to the last-train
  // chain, the straight-line distance and a speed estimate.
  let segments = canonical.segments;
  const segmentMetrics = await harvestAdjacentSegmentMetrics(
    baiduAk,
    canonical,
    stations,
    opts.skipSegmentMetrics
  );

  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  // The planner measurement wins over the last-train diff; `applyDerivedTimes`
  // keeps `planner` values, so the order is derived → planner → fallbacks.
  segments = applySegmentTimes(segments, segmentMetrics);
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  // ---- Fares ----------------------------------------------------------------
  // The operator publishes its own OD matrix; no harvesting is needed.
  const stationIds = stations.map((s) => s.id).sort();
  const stationNameById = new Map(stations.map((s) => [s.id, s.name] as const));
  const fares = buildLanzhouFareMatrix({
    stationIds,
    stationNameById,
    official: sources.officialFares
  });

  // Cross-check the matrix against the operator's published mileage tariff.
  const locById = new Map(
    stations.filter((s) => s.location).map((s) => [s.id, s.location!] as const)
  );
  const check = verifyFareMatrixAgainstTariff(
    fares,
    (a, b) => {
      const la = locById.get(a);
      const lb = locById.get(b);
      if (!la || !lb) return undefined;
      const R = 6371;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(lb.lat - la.lat);
      const dLon = toRad(lb.lon - la.lon);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(la.lat)) * Math.cos(toRad(lb.lat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    },
    lanzhouMileageFare
  );
  console.log(
    `  fare tariff cross-check: ${check.consistent} OD pairs consistent, ${check.inconsistent} unexplained`
  );
  for (const ex of check.examples) console.log(`    ${ex}`);

  console.log(`  geocode: subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`);
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
    timetables,
    fares
  });
  console.log(`  wrote ${outDir}`);

  // The planner's in-vehicle distance replaces the straight-line estimate, so
  // it is written after `writeCanonical` — which also computed the quality
  // block before the patch.
  if (segmentMetrics.length > 0) {
    await applySegmentDistances(outDir, segmentMetrics);
    await refreshQuality(outDir);
  }

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
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
  runLanzhouNormalize({
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
