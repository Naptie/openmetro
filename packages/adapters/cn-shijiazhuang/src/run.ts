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
  type OfficialTransfer,
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { fetchShijiazhuangSources, type ShijiazhuangSources } from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_ID, SHIJIAZHUANG_LINES } from './lines.js';
import { normalizeShijiazhuang } from './normalize.js';
import { harvestSegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestStationTimetables } from './timetables.js';
import { harvestTransferWalks, type TransferCandidate, type TransferStopRef } from './transfers.js';

export interface ShijiazhuangNormalizeOptions {
  /** Repository root containing `data/cn-shijiazhuang`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu adjacent-pair segment metric harvest (dev runs). */
  skipSegmentMetrics?: boolean;
  /** Skip the Baidu station-hall transfer walk harvest (dev runs). */
  skipTransferWalks?: boolean;
}

/** AMap GCJ-02 coordinates keyed by folded station name. */
function amapCoordsByFold(sources: ShijiazhuangSources): Map<string, { lon: number; lat: number }> {
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
 * Planner station refs for one line, in the official line order.
 *
 * The official feed's order is authoritative (its `order_on_line` is not), so
 * the refs follow the official sequence and only borrow coordinates from AMap.
 */
function refsForLine(
  sources: ShijiazhuangSources,
  officialId: number,
  coordsByFold: Map<string, { lon: number; lat: number }>
): BaiduStationRef[] {
  const stations = sources.stationsByLine.get(officialId) ?? [];
  const refs: BaiduStationRef[] = [];
  for (const station of stations) {
    const name = station.station_name.trim();
    const coord = coordsByFold.get(name);
    if (!name || !coord) continue;
    refs.push({ name, lon: coord.lon, lat: coord.lat });
  }
  return refs;
}

export async function runShijiazhuangNormalize(
  opts: ShijiazhuangNormalizeOptions = {}
): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-shijiazhuang');

  const sources = await fetchShijiazhuangSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Shijiazhuang first/last trains, segment metrics, transfer walks and fares are harvested via Baidu Direction v2 (the operator publishes timetable and fares only as static images; no OCR).'
    );
  }

  const coordsByFold = amapCoordsByFold(sources);

  // ---- First/last trains, per line -----------------------------------------
  const harvestedTimes = new Map<number, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  if (!opts.skipTimetables && baiduAk) {
    for (const line of [...sources.lines].sort((a, b) => a.line_id - b.line_id)) {
      const cfg = LINE_CONFIG_BY_OFFICIAL_ID.get(line.line_id);
      if (!cfg) continue;
      const refs = refsForLine(sources, line.line_id, coordsByFold);
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no coords)`);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 320, retries: 1 });
      const withTimes = rows.filter(
        (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
      ).length;
      if (withTimes < Math.ceil(refs.length * 0.8)) {
        throw new Error(
          `${cfg.short}: Baidu harvest covered only ${withTimes}/${refs.length} stations with times — refusing to write partial timetables`
        );
      }
      console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
      harvestedTimes.set(line.line_id, rows);
    }
  }

  const canonical = normalizeShijiazhuang({ sources, harvestedTimes });

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '石家庄',
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

  // ---- Station-hall transfer walks -----------------------------------------
  const cfgByLineId = new Map<string, (typeof SHIJIAZHUANG_LINES)[number]>(
    SHIJIAZHUANG_LINES.map((c) => [`cn-shijiazhuang-line-${c.slug}`, c] as const)
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

  // Last-train diffs are a free by-product of the first/last harvest; the
  // planner measurements above win where they exist.
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
    console.log('  compute OD fares from the official tariff over planner mileage');
    await computeAndWriteFares(outDir, baiduAk ?? undefined);
  }

  // Re-stamp quality after the planner distances, transfer walks and fares
  // land: `writeCanonical` computed it before those patches, so the distance
  // layer still carried the haversine marker at that point.
  await refreshQuality(outDir);

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
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
  runShijiazhuangNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipTransferWalks: process.argv.includes('--skip-transfer-walks')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
