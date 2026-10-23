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
import {
  buildRailAdjacency,
  minRailDistanceKm,
  nanchangFareSpec,
  verifyFareMatrixAgainstTariff
} from './fares.js';
import {
  fetchNanchangSources,
  fetchOfficialAllLine,
  fetchOfficialSiteInfo,
  type OfficialSiteInfo
} from './fetch.js';
import { foldNanchangStationName, NANCHANG_LINES, type NanchangLineConfig } from './lines.js';
import {
  type NanchangCanonical,
  normalizeNanchang,
  type OfficialSegmentTime
} from './normalize.js';
import {
  harvestOfficialSegmentTimes,
  harvestSegmentMetrics,
  type SegmentMetrics,
  type SegmentPairQuery
} from './segments.js';
import { harvestStationTimetables, serviceBandFor } from './timetables.js';

export interface NanchangNormalizeOptions {
  /** Repository root containing `data/cn-nanchang`. */
  root?: string;
  skipGeocode?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu adjacent-pair distance harvest (dev runs). */
  skipSegmentMetrics?: boolean;
  /** Skip the operator's per-station exits / bus interchange harvest. */
  skipSiteInfo?: boolean;
  /** Skip the official OD fare matrix. */
  skipFares?: boolean;
}

type Sources = Awaited<ReturnType<typeof fetchNanchangSources>>;

/**
 * AMap GCJ-02 coordinates keyed by the folded station name.
 *
 * AMap and the operator spell the same station with a different `站` suffix
 * policy, so both sides are folded by removing one trailing `站`.
 */
function amapCoordsByFold(sources: Sources) {
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
      out.set(foldNanchangStationName(n), { lon, lat });
    }
  }
  return out;
}

/**
 * Planner station refs for one line, in the operator's official line order.
 *
 * The order comes from the operator's `AllLine` payload; only the coordinates
 * are borrowed from AMap.
 */
function refsForLine(
  sources: Sources,
  officialId: string,
  coordsByFold: Map<string, { lon: number; lat: number }>
): { name: string; lon: number; lat: number }[] {
  const stations = sources.official.data?.[officialId] ?? [];
  const refs: { name: string; lon: number; lat: number }[] = [];
  for (const st of stations) {
    const name = String(st.siteName ?? '').trim();
    const coord = coordsByFold.get(foldNanchangStationName(name));
    if (!coord) continue;
    refs.push({ name, lon: coord.lon, lat: coord.lat });
  }
  return refs;
}

/**
 * The AMap subway dataset, re-keyed onto the canonical station names.
 *
 * AMap appends the `站` suffix to a few compounds (`南昌西站`, `南昌东站`) while
 * the operator appends it everywhere, so the two feeds only line up after the
 * fold. The cascade looks names up exactly, hence the re-keying.
 */
function buildSubwayStations(sources: Sources, canonical: NanchangCanonical) {
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
      const fold = foldNanchangStationName(n);
      out.push({
        name: canonical.canonicalNameByFold.get(fold) ?? n,
        pinyin: st.sp,
        poiid: st.poiid,
        location: { lon, lat, crs: 'gcj02' }
      });
    }
  }
  return out;
}

/**
 * One query per adjacent stop pair, in official line order.
 *
 * The pair list follows the operator's line order, so the planner's own
 * direction (which the operator only answers in the direction of travel) is
 * respected. Stop ids come from the canonical stop list, so the harvested
 * metrics land on the right segments.
 */
function buildSegmentPairs(
  canonical: NanchangCanonical,
  cfg: NanchangLineConfig,
  coordsByFold: Map<string, { lon: number; lat: number }>
): SegmentPairQuery[] {
  const stops = canonical.stopsByLineId.get(`cn-nanchang-line-${cfg.slug}`) ?? [];
  const out: SegmentPairQuery[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const aName = String(a.extras?.official_name ?? '');
    const bName = String(b.extras?.official_name ?? '');
    const ca = coordsByFold.get(foldNanchangStationName(aName));
    const cb = coordsByFold.get(foldNanchangStationName(bName));
    if (!ca || !cb) continue;
    out.push({
      line: cfg,
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

export async function runNanchangNormalize(opts: NanchangNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-nanchang');

  const sources = await fetchNanchangSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Nanchang per-station first/last trains are harvested via Baidu Direction v2 (the operator publishes its timetable sheets only as static images; no OCR).'
    );
  }

  const coordsByFold = amapCoordsByFold(sources);

  // First pass: the canonical topology. Station and stop ids are derived
  // deterministically from the operator's payload, so a second pass with the
  // harvested data produces exactly the same ids.
  const provisional = normalizeNanchang({ sources });

  // ---- Adjacent-pair queries ------------------------------------------------
  const pairsByLine = new Map<string, SegmentPairQuery[]>();
  for (const cfg of NANCHANG_LINES) {
    const pairs = buildSegmentPairs(provisional, cfg, coordsByFold);
    if (pairs.length > 0) pairsByLine.set(cfg.officialId, pairs);
  }
  const allPairs = [...pairsByLine.values()].flat();

  // ---- Official per-hop run times -------------------------------------------
  // The operator's planner answers a same-line adjacent-station query with
  // that hop's run time, so the official run time lands on every segment.
  console.log(`  harvest ${allPairs.length} official adjacent-hop run times`);
  const officialTimes = await harvestOfficialSegmentTimes(allPairs, { delayMs: 100, retries: 2 });
  console.log(`    official hop times: ${officialTimes.size}/${allPairs.length}`);

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
    for (const cfg of NANCHANG_LINES) {
      const refs = refsForLine(sources, cfg.officialId, coordsByFold);
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no AMap coordinates)`);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 250, retries: 1 });
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

  // ---- Operator station exits / bus interchange ------------------------------
  const siteInfo = new Map<string, OfficialSiteInfo[]>();
  if (!opts.skipSiteInfo) {
    console.log('  fetch operator station exits / bus interchange');
    const officialNames = new Set<string>();
    for (const line of NANCHANG_LINES) {
      for (const st of sources.official.data?.[line.officialId] ?? []) {
        officialNames.add(String(st.siteName ?? '').trim());
      }
    }
    let ok = 0;
    for (const name of officialNames) {
      const info = await fetchOfficialSiteInfo(name).catch(() => undefined);
      if (info?.length) {
        siteInfo.set(name, info);
        ok++;
      }
    }
    console.log(`    station detail: ${ok}/${officialNames.size} stations`);
  }

  // ---- Normalize (second pass, with the harvested data) ---------------------
  const officialSegmentTimes = new Map<string, OfficialSegmentTime>();
  for (const [key, value] of officialTimes) {
    officialSegmentTimes.set(key, { seconds: value.seconds, minutes: value.minutes });
  }
  const canonical = normalizeNanchang({
    sources,
    harvestedTimes,
    officialSegmentTimes,
    siteInfo,
    serviceBand: serviceBandFor(new Date())
  });

  // The operator's own station names feed the planner's fare key; rebuild the
  // official-name → lines mapping for the fare spec.
  const officialLinesByName = new Map<string, string[]>();
  for (const [officialName, stationId] of canonical.plannerKeyByOfficialName) {
    const lines = canonical.officialLinesByStationId.get(stationId) ?? [];
    officialLinesByName.set(officialName, lines);
  }

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
  //
  // The AMap dataset the adapter already fetched is injected into the cascade
  // rather than letting core fetch it again: AMap appends `站` to a few
  // compounds (`南昌西站`, `南昌东站`) while the operator appends it everywhere,
  // so the entries are re-keyed onto the canonical names here — otherwise
  // those two stations would never match the cascade's exact-name lookup.
  // It also removes the dependency on AMap's city-list endpoint, which the
  // core's own fetcher needs to resolve `南昌` → `3601_drw_nanchang`.
  const subwayStations = buildSubwayStations(sources, canonical);
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '南昌',
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
  // The operator publishes no transfer walk times (its planner only reports the
  // number of changes), so the edges carry no walk time here — the core
  // `gapfill` layer measures them with the Baidu planner.
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // ---- Segment times ----------------------------------------------------------
  // The operator's own run time is already on the segments (source). The
  // last-train chain and the distance/speed model only fill the holes.
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
  if (!opts.skipFares) {
    console.log('  harvest official OD fare matrix');
    await syncFares({ dataDir: outDir }, nanchangFareSpec({ officialLinesByName }), {
      concurrency: 6,
      delay: 40
    });
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

/**
 * Cross-check the harvested fare matrix against the operator's published
 * mileage tariff.
 *
 * The tariff prices the **shortest rail path**, so the comparison uses the
 * minimum rail distance between two stations (transfers are free).
 */
async function crossCheckFares(dataDir: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const faresDoc = JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8')) as {
    station_ids: string[];
    fares: (number | null)[][];
  };
  const segments = JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
    from_station_id: string;
    to_station_id: string;
    distance_km?: number;
  }[];
  const ids = faresDoc.station_ids;
  const adj = buildRailAdjacency(ids, segments);
  // All-pairs shortest rail distance, computed once (the tariff prices the
  // shortest path, and transfers are free).
  const railKm: number[][] = ids.map((_, i) => minRailDistanceKm(i, ids, adj));
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const check = verifyFareMatrixAgainstTariff(faresDoc, (a, b) => {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) return undefined;
    const d = railKm[i]?.[j];
    return d != null && Number.isFinite(d) ? d : undefined;
  });
  console.log(
    `  fare tariff cross-check: ${check.consistent} OD pairs consistent, ${check.inconsistent} unexplained`
  );
  for (const ex of check.examples) console.log(`    ${ex}`);
}

/**
 * Fares-only sync: harvest the operator's OD matrix for the station ids that
 * are already on disk.
 *
 * Only the operator's line membership has to be re-read (one `AllLine` call);
 * the station list, the planner keys and the matrix layout come from
 * `stations.json`.
 */
export async function writeNanchangFares(dataDir: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as {
      id: string;
      name: string;
      extras?: Record<string, unknown>;
    }[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  if (stations.length === 0) throw new Error('fares: stations.json is empty');

  const official = await fetchOfficialAllLine();
  const officialLinesByName = new Map<string, string[]>();
  for (const [lineId, stops] of Object.entries(official.data ?? {})) {
    for (const st of stops ?? []) {
      const name = String(st.siteName ?? '').trim();
      if (!name) continue;
      const list = officialLinesByName.get(name) ?? [];
      if (!list.includes(lineId)) list.push(lineId);
      officialLinesByName.set(name, list);
    }
  }

  console.log('  harvest official OD fare matrix');
  await syncFares({ dataDir }, nanchangFareSpec({ officialLinesByName }), {
    concurrency: 6,
    delay: 40
  });
  await refreshQuality(dataDir);
  await crossCheckFares(dataDir);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runNanchangNormalize({
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipSiteInfo: process.argv.includes('--skip-site-info'),
    skipFares: process.argv.includes('--skip-fares'),
    skipGeocode: process.argv.includes('--skip-geocode')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
