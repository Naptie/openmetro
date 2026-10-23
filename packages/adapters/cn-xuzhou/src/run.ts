import { join } from 'node:path';
import {
  applyDerivedTimes,
  applyHarvestedSegmentTimes,
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
  type OfficialTransfer,
  writeCanonical
} from '@openmetro/core';
import {
  buildNetworkDistanceMatrix,
  buildXuzhouFareMatrix,
  type FareStationRef,
  odFareCacheFile,
  sweepOfficialOdFares,
  verifyFareMatrixAgainstTariff,
  writeXuzhouFares
} from './fares.js';
import {
  fetchDropBox,
  fetchStationDetail,
  fetchXuzhouSources,
  setXuzhouRequestInterval,
  type XuzhouSources
} from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_NAME, XUZHOU_LINES } from './lines.js';
import { normalizeXuzhou } from './normalize.js';
import { harvestSegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestTransferWalks, type TransferCandidate, type TransferStopRef } from './transfers.js';

export interface XuzhouNormalizeOptions {
  /** Repository root containing `data/cn-xuzhou`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair segment metric harvest (dev runs). */
  skipSegmentMetrics?: boolean;
  /** Skip the Baidu station-hall transfer walk harvest (dev runs). */
  skipTransferWalks?: boolean;
  /** Skip the official per-station detail pages (exits, landmarks, facilities). */
  skipStationDetails?: boolean;
  /** Cap on the official fare sweep (dev runs). */
  maxFareQueries?: number;
}

export async function runXuzhouNormalize(opts: XuzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-xuzhou');

  // The operator's origin throttles bursts behind its WAF; keep the spacing
  // polite — the station-detail phase alone issues 76 requests.
  setXuzhouRequestInterval(700);

  const sources = await fetchXuzhouSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipSegmentMetrics) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Xuzhou segment metrics and transfer walks are measured via Baidu Direction v2 (the operator publishes neither).'
    );
  }

  const canonical = normalizeXuzhou({ sources });

  // ---- English names (Wikidata is only a safety net here) -------------------
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '徐州',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
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
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
  }

  // ---- Station detail pages (exits, landmarks, facilities) ------------------
  if (!opts.skipStationDetails) {
    await attachStationDetails(stations, sources, outDir);
  }

  // ---- Station-hall transfer walks -----------------------------------------
  const cfgByLineId = new Map<string, (typeof XUZHOU_LINES)[number]>(
    XUZHOU_LINES.map((c) => [`cn-xuzhou-line-${c.slug}`, c] as const)
  );
  const stationById = new Map(canonical.stations.map((s) => [s.id, s] as const));
  const transferCandidates: TransferCandidate[] = [];
  for (const [stationId, lineIds] of canonical.interchanges) {
    const station = stationById.get(stationId);
    if (!station?.location) continue;
    const stopsByLine = new Map<string, TransferStopRef[]>();
    for (const lineId of lineIds) {
      const lineStops = canonical.stopsByLineId.get(lineId) ?? [];
      stopsByLine.set(
        lineId,
        lineStops.map((stop) => {
          const phys = stationById.get(stop.station_id);
          return {
            name: phys?.name ?? stop.station_id,
            lon: phys?.location?.lon ?? station.location!.lon,
            lat: phys?.location?.lat ?? station.location!.lat
          };
        })
      );
    }
    transferCandidates.push({
      stationId,
      stationName: station.name,
      lon: station.location.lon,
      lat: station.location.lat,
      lineIds,
      stopsByLine,
      cfgByLine: cfgByLineId
    });
  }

  let officialTransfers: OfficialTransfer[] = [];
  const transferWalks = new Map<
    string,
    { walkTimeSeconds?: number; walkDistanceMeters?: number }
  >();
  if (!opts.skipTransferWalks && baiduAk) {
    console.log(
      `  harvest station-hall transfer walks (${transferCandidates.length} interchanges)`
    );
    const walks = await harvestTransferWalks(baiduAk, transferCandidates, {
      delayMs: 320,
      retries: 1
    });
    officialTransfers = walks.map((w) => ({
      station_id: w.stationId,
      from_line_id: w.fromLineId,
      to_line_id: w.toLineId,
      walk_time_seconds: w.walkTimeSeconds,
      is_out_of_station: false,
      source_id: w.sourceId
    }));
    for (const w of walks) {
      transferWalks.set(`${w.stationId}|${w.fromLineId}|${w.toLineId}`, {
        walkTimeSeconds: w.walkTimeSeconds,
        walkDistanceMeters: w.walkDistanceMeters
      });
    }
  }

  const transfers = deriveTransfers(stations, canonical.stops, officialTransfers, {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // ---- Segment metrics ------------------------------------------------------
  let segments = canonical.segments;
  let segmentMetrics = new Map<string, { duration: number | null; meters: number | null }>();
  if (!opts.skipSegmentMetrics && baiduAk) {
    const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
    const queries: SegmentPairQuery[] = [];
    const seenPairs = new Set<string>();
    for (const pattern of canonical.patterns) {
      const cfg = cfgByLineId.get(pattern.line_id);
      if (!cfg) continue;
      for (let i = 0; i + 1 < pattern.stop_ids.length; i++) {
        const a = stopById.get(pattern.stop_ids[i]!);
        const b = stopById.get(pattern.stop_ids[i + 1]!);
        if (!a || !b) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
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
    const metrics = await harvestSegmentMetrics(baiduAk, queries, { delayMs: 320, retries: 1 });
    segmentMetrics = new Map(
      metrics.map(
        (m) =>
          [
            [m.fromStopId, m.toStopId].sort().join('|'),
            { duration: m.durationSeconds, meters: m.distanceMeters }
          ] as const
      )
    );
    const withDuration = metrics.filter((m) => (m.durationSeconds ?? 0) > 0).length;
    const withDistance = metrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(
      `  segment metrics: ${withDuration}/${metrics.length} durations, ${withDistance}/${metrics.length} distances`
    );

    segments = applyHarvestedSegmentTimes(
      segments,
      metrics
        .filter((m) => (m.durationSeconds ?? 0) > 0)
        .map((m) => ({
          from_stop_id: m.fromStopId,
          to_stop_id: m.toStopId,
          travel_time_seconds: m.durationSeconds!,
          source_id: 'baidu-transit-direction'
        }))
    ).segments;
  }

  // Last-train diffs are a free by-product of the official first/last sheet;
  // the planner measurements above win where they exist.
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

  if (!opts.skipSegmentMetrics) {
    await applySegmentDistances(outDir, segmentMetrics);
  }
  if (transferWalks.size > 0) {
    await applyTransferDistances(outDir, transferWalks);
  }

  if (!opts.skipFares) {
    await writeOfficialFares(canonical, stations, root, opts.maxFareQueries);
  }

  // Re-stamp quality after the planner distances, transfer walks and fares
  // land: `writeCanonical` computed it before those patches.
  await refreshQuality(outDir);

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('with english:', stations.filter((s) => s.names.en).length);
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
  console.log('timetables:', timetables.length);
}

/**
 * Attach the operator's per-station detail pages to `stations[].extras`.
 *
 * The pages publish each exit with its landmark, nearby buses and bike dock,
 * the in-station facilities and the station layout plans. The canonical model
 * has no field for them, so they land in `extras`.
 */
async function attachStationDetails(
  stations: { id: string; name: string; extras?: Record<string, unknown> }[],
  sources: XuzhouSources,
  _outDir: string
): Promise<void> {
  const byName = new Map<string, { id: string; extras?: Record<string, unknown> }[]>();
  for (const st of stations) {
    const list = byName.get(st.name) ?? [];
    list.push(st);
    byName.set(st.name, list);
  }

  let fetched = 0;
  for (const line of sources.dropBox) {
    for (const station of line.children ?? []) {
      const name = station.label.trim();
      const targets = byName.get(name);
      if (!targets?.length) continue;
      const detail = await fetchStationDetail(Number(station.value));
      fetched++;
      if (!detail) continue;
      const exits = detail.exits.map((e) => ({
        number: e.number,
        label: e.label,
        ...(e.landmark ? { landmark: e.landmark } : {}),
        ...(e.buses ? { buses: e.buses } : {}),
        ...(e.bike ? { bike: e.bike } : {})
      }));
      for (const target of targets) {
        target.extras = {
          ...(target.extras ?? {}),
          exits,
          ...(detail.facilities ? { facilities: detail.facilities } : {}),
          ...(detail.planPictures?.length ? { plan_pictures: detail.planPictures } : {})
        };
      }
    }
  }
  console.log(`  station detail pages: ${fetched} fetched`);
}

/**
 * Shortest in-vehicle network distance between stations, read from the
 * canonical files on disk.
 *
 * The operator prices on network mileage, so the tariff cross-check needs the
 * distance along the tracks rather than the straight line.
 */
async function networkDistances(
  dataDir: string
): Promise<(a: string, b: string) => number | undefined> {
  const { readFile } = await import('node:fs/promises');
  const read = async (name: string) =>
    JSON.parse(await readFile(join(dataDir, name), 'utf-8')) as { records: unknown[] };
  const [segments, stops] = await Promise.all([read('segments.json'), read('stops.json')]);
  return buildNetworkDistanceMatrix({
    segments: segments.records as {
      from_stop_id: string;
      to_stop_id: string;
      distance_km?: number;
    }[],
    stops: stops.records as { id: string; station_id: string }[]
  });
}

/** Build the official OD fare matrix and write it. */
async function writeOfficialFares(
  canonical: ReturnType<typeof normalizeXuzhou>,
  stations: { id: string; name: string; location?: { lon: number; lat: number } }[],
  root: string,
  maxQueries?: number
): Promise<void> {
  const stationById = new Map(stations.map((s) => [s.id, s] as const));
  const refs: FareStationRef[] = [];
  for (const [stationId, ref] of canonical.plannerRefByStationId) {
    const station = stationById.get(stationId);
    if (!station) continue;
    refs.push({
      stationId,
      name: station.name,
      officialId: ref.officialId,
      lineIndex: ref.lineIndex,
      lon: station.location?.lon,
      lat: station.location?.lat
    });
  }
  refs.sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
  console.log(`  official fare sweep over ${refs.length} stations`);

  const official = await sweepOfficialOdFares(refs, {
    intervalMs: 450,
    concurrency: 3,
    cacheFile: odFareCacheFile(root),
    maxQueries
  });

  const stationIds = refs.map((r) => r.stationId);
  const document = buildXuzhouFareMatrix({ stationIds, official });
  await writeXuzhouFares(join(root, 'data/cn-xuzhou'), document);

  const check = verifyFareMatrixAgainstTariff(
    document,
    await networkDistances(join(root, 'data/cn-xuzhou'))
  );
  console.log(
    `  tariff cross-check: ${check.consistent} consistent, ${check.inconsistent} outside the published band`
  );
  if (check.examples.length) {
    console.log(`    examples: ${check.examples.join('; ')}`);
  }
}

export interface XuzhouFaresOptions {
  /** Repository root containing `data/cn-xuzhou`. */
  root?: string;
  /** Cap on the number of planner queries (dev runs / CI budget). */
  maxQueries?: number;
}

/**
 * Fares-only sync: rebuild the official OD matrix from the data on disk.
 *
 * The operator's planner needs two things per physical station: the official
 * station id and the operator's 0-based line position. The ids live in the
 * operator's `dropBox` tree, so that tree is the single extra request this
 * path makes — the canonical topology itself is read from
 * `data/cn-xuzhou/stations.json`.
 */
export async function runXuzhouFares(opts: XuzhouFaresOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-xuzhou');
  setXuzhouRequestInterval(400);

  const { readFile } = await import('node:fs/promises');
  const stationsDoc = JSON.parse(await readFile(join(outDir, 'stations.json'), 'utf-8')) as {
    records: { id: string; name: string; location?: { lon: number; lat: number } }[];
  };
  const byName = new Map<string, { id: string; location?: { lon: number; lat: number } }[]>();
  for (const s of stationsDoc.records) {
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }

  console.log('  fetch official dropBox tree (planner references)');
  const dropBox = await fetchDropBox();

  const refs: FareStationRef[] = [];
  for (const line of dropBox) {
    const cfg = LINE_CONFIG_BY_OFFICIAL_NAME.get(line.label.trim());
    if (!cfg) continue;
    for (const station of line.children ?? []) {
      const name = station.label.trim();
      const target = byName.get(name)?.[0];
      if (!target) continue;
      refs.push({
        stationId: target.id,
        name,
        officialId: Number(station.value),
        lineIndex: cfg.officialIndex,
        lon: target.location?.lon,
        lat: target.location?.lat
      });
    }
  }
  // One reference per physical station.
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    if (seen.has(r.stationId)) return false;
    seen.add(r.stationId);
    return true;
  });
  unique.sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));

  console.log(`  official fare sweep over ${unique.length} stations`);
  const official = await sweepOfficialOdFares(unique, {
    intervalMs: 450,
    concurrency: 3,
    cacheFile: odFareCacheFile(root),
    maxQueries: opts.maxQueries
  });

  const document = buildXuzhouFareMatrix({
    stationIds: unique.map((r) => r.stationId),
    official
  });
  await writeXuzhouFares(outDir, document);

  const check = verifyFareMatrixAgainstTariff(document, await networkDistances(outDir));
  console.log(
    `  tariff cross-check: ${check.consistent} consistent, ${check.inconsistent} outside the published band`
  );
  if (check.examples.length) {
    console.log(`    examples: ${check.examples.join('; ')}`);
  }
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

/** Apply planner in-vehicle km to segments.json (planner misses keep haversine). */
async function applySegmentDistances(
  dataDir: string,
  metrics: Map<string, { duration: number | null; meters: number | null }>
): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const segmentsPath = join(dataDir, 'segments.json');
  const segDoc = JSON.parse(await readFile(segmentsPath, 'utf-8')) as {
    generated_at?: string;
    records: {
      from_stop_id: string;
      to_stop_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  let applied = 0;
  for (const seg of segDoc.records) {
    const key = [seg.from_stop_id, seg.to_stop_id].sort().join('|');
    const meters = metrics.get(key)?.meters;
    if (meters != null && meters > 0) {
      seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
      applied++;
    }
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(`  segment distances applied: ${applied} planner`);
}

/** Apply the measured station-hall walk distance to transfers.json. */
async function applyTransferDistances(
  dataDir: string,
  walks: Map<string, { walkTimeSeconds?: number; walkDistanceMeters?: number }>
): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const transfersPath = join(dataDir, 'transfers.json');
  const doc = JSON.parse(await readFile(transfersPath, 'utf-8')) as {
    generated_at?: string;
    records: {
      station_id: string;
      from_line_id: string;
      to_line_id: string;
      walk_distance_meters?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  let applied = 0;
  for (const t of doc.records) {
    const walk = walks.get(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`);
    if (!walk?.walkDistanceMeters) continue;
    t.walk_distance_meters = walk.walkDistanceMeters;
    t.extras = { ...(t.extras ?? {}), walk_distance_source: 'baidu-transit-station-hall-walk' };
    applied++;
  }
  doc.generated_at = new Date().toISOString();
  await writeFile(transfersPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  console.log(`  transfer walk distances applied: ${applied}`);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  const maxFareQueries = process.argv.includes('--max-fare-queries')
    ? Number(process.argv[process.argv.indexOf('--max-fare-queries') + 1])
    : undefined;
  const run = process.argv.includes('--fares-only')
    ? runXuzhouFares({ maxQueries: maxFareQueries })
    : runXuzhouNormalize({
        skipFares: !process.argv.includes('--fares'),
        skipSegmentMetrics: process.argv.includes('--skip-segments'),
        skipTransferWalks: process.argv.includes('--skip-transfer-walks'),
        skipStationDetails: process.argv.includes('--skip-station-details'),
        maxFareQueries
      });
  run.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
