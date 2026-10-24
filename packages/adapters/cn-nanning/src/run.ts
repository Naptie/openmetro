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
  syncFares,
  writeCanonical
} from '@openmetro/core';
import { fetchBaiduStationCoordinate } from './baidu.js';
import {
  buildRailAdjacency,
  fillFaresFromTariff,
  minRailDistanceKm,
  nanningFareSpec,
  verifyFareMatrixAgainstTariff
} from './fares.js';
import { fetchNanningSources } from './fetch.js';
import { NANNING_LINES, type NanningLineConfig, PLANNED_STATIONS } from './lines.js';
import { type NanningCanonical, type NormalizeInput, normalizeNanning } from './normalize.js';
import { harvestSegmentMetrics, type SegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestStationTimetables, serviceBandFor } from './timetables.js';

export interface NanningNormalizeOptions {
  /** Repository root containing `data/cn-nanning`. */
  root?: string;
  skipGeocode?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu adjacent-pair distance harvest (dev runs). */
  skipSegmentMetrics?: boolean;
  /** Skip the OD fare matrix. */
  skipFares?: boolean;
}

type Sources = Awaited<ReturnType<typeof fetchNanningSources>>;

/**
 * AMap GCJ-02 coordinates keyed by the operator's station name.
 *
 * The operator's page and the AMap dataset spell the stations identically
 * (no `站` suffix on either side), so the two feeds match one-to-one.
 */
function amapCoordsByName(sources: Sources) {
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
      out.set(n, { lon, lat });
    }
  }
  return out;
}

/**
 * Planner station refs for one line, in the operator's official line order.
 *
 * The order comes from the operator's page; only the coordinates are borrowed
 * from AMap.
 */
function refsForLine(
  sources: Sources,
  officialId: string,
  coordsByName: Map<string, { lon: number; lat: number }>
): { name: string; lon: number; lat: number }[] {
  const official = sources.official.lines.find((l) => l.officialId === officialId);
  if (!official) return [];
  const planned = new Set(PLANNED_STATIONS.filter((p) => p.line === officialId).map((p) => p.name));
  const refs: { name: string; lon: number; lat: number }[] = [];
  for (const st of official.stops) {
    if (planned.has(st.name)) continue;
    const coord = coordsByName.get(st.name);
    if (!coord) continue;
    refs.push({ name: st.name, lon: coord.lon, lat: coord.lat });
  }
  return refs;
}

/**
 * One query per adjacent stop pair, in official line order.
 *
 * The pair list follows the operator's line order, so the planner's own
 * direction (which it only answers in the direction of travel) is respected.
 */
function buildSegmentPairs(
  canonical: NanningCanonical,
  cfg: NanningLineConfig,
  coordsByName: Map<string, { lon: number; lat: number }>
): SegmentPairQuery[] {
  const stops = canonical.stopsByLineId.get(`cn-nanning-line-${cfg.slug}`) ?? [];
  // The ride chain skips the stations the operator lists but does not serve,
  // so the planner is asked for the **through-run** the service actually makes
  // (楞塘村 → 清平坡, past 五象火车站) — a hop it can answer — instead of for
  // the two legs into a station it has no service for.
  const notInService = new Set(
    canonical.stations.filter((s) => s.status !== 'operating').map((s) => s.id)
  );
  const chain = stops.filter((s) => !notInService.has(s.station_id));
  const out: SegmentPairQuery[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const aName = String(a.extras?.official_name ?? '');
    const bName = String(b.extras?.official_name ?? '');
    const ca = coordsByName.get(aName);
    const cb = coordsByName.get(bName);
    if (!ca || !cb) continue;
    out.push({
      lineNumber: cfg.short,
      fromStopId: a.id,
      toStopId: b.id,
      fromOfficialName: aName,
      toOfficialName: bName,
      from: { name: aName, lon: ca.lon, lat: ca.lat },
      to: { name: bName, lon: cb.lon, lat: cb.lat }
    });
  }
  return out;
}

/**
 * The AMap subway dataset, re-keyed onto the canonical station names.
 *
 * The AMap entries are injected into the coordinate cascade rather than
 * letting core fetch the dataset again: it removes the dependency on AMap's
 * city-list endpoint, which the core's own fetcher needs to resolve
 * `南宁` → `4501_drw_nanning`.
 */
function buildSubwayStations(sources: Sources) {
  const out: {
    name: string;
    pinyin?: string;
    poiid?: string;
    location: { lon: number; lat: number; crs: 'gcj02' };
  }[] = [];
  for (const line of sources.amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.push({
        name: n,
        pinyin: st.sp,
        poiid: st.poiid,
        location: { lon, lat, crs: 'gcj02' }
      });
    }
  }
  return out;
}

/** Recompute `network.quality` from the final canonical files on disk. */
async function refreshQuality(dataDir: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
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

/**
 * Write the planner's in-vehicle distance onto the segments on disk.
 *
 * A **through-run** edge (a segment that runs past a station the operator
 * lists but does not serve) also gets the planner's ride time: no pattern
 * lists its ends as adjacent, so the core `gapfill` layer — which pairs
 * segments by pattern adjacency — can never measure it.
 */
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
      travel_time_seconds?: number;
      travel_time_source?: string;
      travel_time_derived_from?: string[];
      extras?: Record<string, unknown>;
    }[];
  };
  const byPair = new Map(
    metrics.map((m) => [[m.fromStopId, m.toStopId].sort().join('|'), m] as const)
  );
  let applied = 0;
  for (const seg of doc.records) {
    const key = [seg.from_stop_id, seg.to_stop_id].sort().join('|');
    const hit = byPair.get(key);
    const meters = hit?.distanceMeters;
    if (meters == null || meters <= 0) continue;
    seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
    seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
    // A through-run edge is not adjacent on any pattern, so the core gapfill
    // never reaches it — the planner's own ride time is written here.
    const isThroughRun = Array.isArray(seg.extras?.skips_station_ids);
    const duration = hit?.durationSeconds;
    const weak =
      seg.travel_time_source == null ||
      seg.travel_time_source === 'estimated' ||
      seg.travel_time_source === 'last_train';
    if (isThroughRun && duration != null && duration > 0 && weak) {
      seg.travel_time_seconds = duration;
      seg.travel_time_source = 'planner';
      seg.travel_time_derived_from = undefined;
      seg.extras = { ...seg.extras, planner_time_source: 'baidu-transit' };
    }
    applied++;
  }
  doc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  console.log(`  segment distances applied: ${applied} planner`);
}

/** Cross-check the harvested fare matrix against the operator's published tariff. */
async function crossCheckFares(dataDir: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const matrix = JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8')) as {
    station_ids: string[];
    fares: (number | null)[][];
  };
  const segmentsDoc = JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')) as {
    records: {
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
    }[];
  };
  const ids = matrix.station_ids;
  const adj = buildRailAdjacency(ids, segmentsDoc.records);
  const cache = new Map<number, number[]>();
  const distanceKm = (a: string, b: string): number | undefined => {
    const i = ids.indexOf(a);
    const j = ids.indexOf(b);
    if (i < 0 || j < 0) return undefined;
    if (!cache.has(i)) cache.set(i, minRailDistanceKm(i, ids, adj));
    const km = cache.get(i)![j];
    return Number.isFinite(km) ? km : undefined;
  };
  const check = verifyFareMatrixAgainstTariff(matrix, distanceKm);
  const priced = matrix.fares.reduce(
    (n, row) => n + row.filter((p) => p != null && p > 0).length,
    0
  );
  console.log(
    `  fare cross-check vs published tariff: ${check.consistent} consistent, ${check.inconsistent} differing (${priced} priced cells)`
  );
  for (const ex of check.examples.slice(0, 6)) console.log(`    ${ex}`);
}

/**
 * Fares-only sync.
 *
 * The station ids and their coordinates are already on disk, so the fare
 * matrix can be rebuilt without re-harvesting the topology. Nothing but
 * `fares.json` and `network.json` is touched.
 */
export async function writeNanningFares(dataDir: string): Promise<void> {
  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Nanning OD fares are harvested via the Baidu planner.'
    );
  }
  const { readFile } = await import('node:fs/promises');
  const stationsDoc = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')) as {
    records: StationEncoded[];
  };
  const coordsByStationId = new Map(
    stationsDoc.records
      .filter((s) => s.location)
      .map((s) => [s.id, { lon: s.location!.lon, lat: s.location!.lat }] as const)
  );

  console.log('  harvest OD fare matrix via Baidu Direction v2');
  await syncFares({ dataDir }, nanningFareSpec({ ak: baiduAk, coordsByStationId }), {
    concurrency: 4,
    delay: 120
  });

  const segmentsDoc = JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')) as {
    records: SegmentEncoded[];
  };
  const routable = new Set(
    stationsDoc.records.filter((s) => s.status === 'operating').map((s) => s.id)
  );
  const fallback = await fillFaresFromTariff(dataDir, {
    segments: segmentsDoc.records,
    routableStationIds: routable
  });
  console.log(
    `  tariff fallback: ${fallback.filled} pairs filled, ${fallback.unreachable} unreachable`
  );
  await refreshQuality(dataDir);
  await crossCheckFares(dataDir);
}

export async function runNanningNormalize(opts: NanningNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-nanning');

  const sources = await fetchNanningSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && (!opts.skipTimetables || !opts.skipSegmentMetrics || !opts.skipFares)) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Nanning per-station first/last trains, segment distances and OD fares are harvested via the Baidu planner (the operator publishes its timetable sheets only as static images; no OCR).'
    );
  }

  const coordsByName = amapCoordsByName(sources);

  // ---- The planned station's coordinate ------------------------------------
  // 五象火车站 is announced but not in service, so the AMap subway dataset does
  // not carry it. The planner's place index does — the guard is the address,
  // which names the line for the station and not for the other 五象 places.
  const plannedCoordinates = new Map<string, { lon: number; lat: number }>();
  if (baiduAk) {
    for (const planned of PLANNED_STATIONS) {
      const coord = await fetchBaiduStationCoordinate(baiduAk, planned.name, {
        region: '南宁市',
        addressHint: '轨道交通4号线'
      }).catch(() => null);
      if (coord) {
        plannedCoordinates.set(planned.name, coord);
        console.log(
          `  ${planned.name}: coordinate from the place index (${coord.lon}, ${coord.lat})`
        );
      } else {
        console.log(
          `  ${planned.name}: no coordinate found — its segment stays without a distance`
        );
      }
    }
  }

  // First pass: the canonical topology. Station and stop ids are derived
  // deterministically from the operator's page, so a second pass with the
  // harvested data produces exactly the same ids.
  const provisional = normalizeNanning({ sources });

  // ---- Adjacent-pair queries ------------------------------------------------
  const pairsByLine = new Map<string, SegmentPairQuery[]>();
  for (const cfg of NANNING_LINES) {
    const pairs = buildSegmentPairs(provisional, cfg, coordsByName);
    if (pairs.length > 0) pairsByLine.set(cfg.officialId, pairs);
  }
  const allPairs = [...pairsByLine.values()].flat();

  // ---- Baidu segment distances ----------------------------------------------
  let segmentMetrics: SegmentMetrics[] = [];
  if (!opts.skipSegmentMetrics && baiduAk) {
    console.log(`  harvest ${allPairs.length} adjacent-pair distances via Baidu Direction v2`);
    segmentMetrics = await harvestSegmentMetrics(baiduAk, allPairs, { delayMs: 250, retries: 1 });
    const withDistance = segmentMetrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(`    segment distances: ${withDistance}/${segmentMetrics.length}`);
  }

  // ---- First/last trains, per line -----------------------------------------
  const harvestedTimes = new Map<string, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  if (!opts.skipTimetables && baiduAk) {
    for (const cfg of NANNING_LINES) {
      const refs = refsForLine(sources, cfg.officialId, coordsByName);
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no AMap coordinates)`);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 220, retries: 1 });
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
        if (!isLast && !(row.downFirst && row.downLast)) gaps.push(`${row.stationName}→down`);
        if (!isFirst && !(row.upFirst && row.upLast)) gaps.push(`${row.stationName}→up`);
      });
      if (gaps.length > 0) {
        console.log(
          `    ${cfg.short}: ${gaps.length} direction(s) without times: ${gaps.join(', ')}`
        );
      }
      console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
      harvestedTimes.set(cfg.officialId, rows);
    }
  }

  // ---- Normalize (second pass, with the harvested data) ---------------------
  const normalizeInput: NormalizeInput = {
    sources,
    harvestedTimes,
    serviceBand: serviceBandFor(new Date()),
    plannedCoordinates
  };
  const canonical = normalizeNanning(normalizeInput);

  // ---- English names ---------------------------------------------------------
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations: StationEncoded[] = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  const withoutEnglish = stations.filter((s) => !s.names.en.trim()).length;
  if (withoutEnglish > 0) {
    console.log(`  stations without an English name: ${withoutEnglish}`);
  }

  // ---- Coordinates ------------------------------------------------------------
  // The operator publishes no coordinates, so the AMap Subway dataset is the
  // source. `fillCoordinates` re-resolves them through the standard cascade
  // (AMap → Overpass → Photon) and records the provenance per station.
  const subwayStations = buildSubwayStations(sources);
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '南宁',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      fetchers: { fetchSubway: async () => subwayStations },
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    for (let i = 0; i < located.length; i++) stations[i] = located[i]!;
  }

  // ---- Transfers --------------------------------------------------------------
  // The operator publishes no transfer walk times (its station notes only say
  // whether a change is possible), so the edges carry no walk time here — the
  // core `gapfill` layer measures them with the Baidu planner.
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // ---- Segment times ----------------------------------------------------------
  // The planner's in-vehicle distance lands on the segments below; the
  // last-train chain and the distance/speed model fill the time holes.
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
    timetables
  });
  console.log(`  wrote ${outDir}`);

  // The planner's in-vehicle distance replaces the straight-line estimate, so
  // it is written after `writeCanonical` — which also computed the quality
  // block before the patch.
  if (segmentMetrics.length > 0) {
    await applySegmentDistances(outDir, segmentMetrics);
    await refreshQuality(outDir);
  }

  // ---- Fares ------------------------------------------------------------------
  if (!opts.skipFares && baiduAk) {
    console.log('  harvest OD fare matrix via Baidu Direction v2');
    const coordsByStationId = new Map(
      stations
        .filter((s) => s.location)
        .map((s) => [s.id, { lon: s.location!.lon, lat: s.location!.lat }] as const)
    );
    await syncFares({ dataDir: outDir }, nanningFareSpec({ ak: baiduAk, coordsByStationId }), {
      concurrency: 4,
      delay: 120
    });

    // The pairs the planner could not route rail-only fall back to the
    // operator's published mileage ladder over the measured rail distance.
    const segmentsDoc = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(outDir, 'segments.json'), 'utf-8')
    ) as { records: SegmentEncoded[] };
    const routable = new Set(stations.filter((s) => s.status === 'operating').map((s) => s.id));
    const fallback = await fillFaresFromTariff(outDir, {
      segments: segmentsDoc.records,
      routableStationIds: routable
    });
    console.log(
      `  tariff fallback: ${fallback.filled} pairs filled, ${fallback.unreachable} unreachable`
    );
    await refreshQuality(outDir);
    await crossCheckFares(outDir);
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
