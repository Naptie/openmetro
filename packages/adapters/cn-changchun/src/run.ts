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
  haversineKm,
  loadBaiduAk,
  normalizeTimetableTimes,
  type OfficialTransfer,
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { fetchChangchunSources } from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_CODE } from './lines.js';
import { normalizeChangchun } from './normalize.js';
import {
  type HarvestedSegmentMetric,
  harvestSegmentMetrics,
  type SegmentPairQuery
} from './segments.js';
import { harvestStationTimetables } from './timetables.js';
import { harvestTransferWalks, type TransferCandidate, type TransferStopRef } from './transfers.js';

export interface ChangchunNormalizeOptions {
  /** Repository root containing `data/cn-changchun`. */
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

export async function runChangchunNormalize(opts: ChangchunNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-changchun');

  const sources = await fetchChangchunSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Changchun first/last trains, segment metrics and transfer walks are harvested via Baidu Direction v2 (the operator publishes its timetables only as images; no OCR).'
    );
  }

  // ---- First/last trains, per line -----------------------------------------
  const harvestedTimes = new Map<string, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  if (!opts.skipTimetables && baiduAk) {
    for (const line of [...sources.lines].sort((a, b) => (a.indexno ?? 0) - (b.indexno ?? 0))) {
      const cfg = LINE_CONFIG_BY_OFFICIAL_CODE.get(line.linecode);
      if (!cfg) continue;
      // The official feed's coordinate is platform-level; the planner resolves
      // stations by position, so the station-level centroid is the better
      // query point. Both are GCJ-02.
      const refs: BaiduStationRef[] = [];
      for (const stop of line.standList) {
        const amap = (sources.amap.l ?? [])
          .flatMap((l) => l.st ?? [])
          .find((st) => st.n === stop.cname);
        const sl = String(amap?.sl ?? '')
          .split(',')
          .map(Number);
        if (sl.length !== 2 || !Number.isFinite(sl[0]) || !Number.isFinite(sl[1])) continue;
        refs.push({ name: stop.cname, lon: sl[0]!, lat: sl[1]! });
      }
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no coordinates)`);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 320, retries: 1 });
      const withTimes = rows.filter(
        (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
      ).length;
      console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
      harvestedTimes.set(line.linecode, rows);
    }
  }

  const canonical = normalizeChangchun({ sources, harvestedTimes });

  const enFill = await fillStationEnglishNames(canonical.stations);
  let stations = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '长春',
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
  const stationById = new Map(canonical.stations.map((s) => [s.id, s] as const));
  const cfgByLineId = new Map(
    canonical.lines.map(
      (l) =>
        [
          l.id,
          {
            short: l.short_name,
            name: l.name,
            slug: l.short_name,
            mode: l.mode,
            baiduNameHint: String(
              (l.extras as { baidu_vehicle_name?: string } | undefined)?.baidu_vehicle_name ?? ''
            )
          }
        ] as const
    )
  );
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
      cfgByLine: cfgByLineId as never
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
  let segmentMetrics: HarvestedSegmentMetric[] = [];
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
        const key = `${pattern.line_id}|${[a.id, b.id].sort().join('|')}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const sa = stationById.get(a.station_id);
        const sb = stationById.get(b.station_id);
        if (!sa?.location || !sb?.location) continue;
        queries.push({
          lineId: pattern.line_id,
          fromStopId: a.id,
          toStopId: b.id,
          fromStationId: a.station_id,
          toStationId: b.station_id,
          from: { name: sa.name, lon: sa.location.lon, lat: sa.location.lat },
          to: { name: sb.name, lon: sb.location.lon, lat: sb.location.lat },
          baiduName: cfg.baiduNameHint
        });
      }
    }
    console.log(`  harvest ${queries.length} adjacent-pair segment metrics via Baidu Direction v2`);
    const result = await harvestSegmentMetrics(baiduAk, queries, { delayMs: 320, retries: 1 });
    segmentMetrics = result.metrics;
    const withDistance = segmentMetrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(`  segment metrics: ${withDistance}/${segmentMetrics.length} distances`);
  }

  // Planner in-vehicle times win over the derived last-train chain, as the
  // repository's segment-time priority prescribes (`source` → `planner` →
  // `last_train` → `estimated`). The derived chain stays as the fallback for
  // pairs the planner does not answer.
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  if (!opts.skipSegmentMetrics && segmentMetrics.length > 0) {
    segments = applyHarvestedSegmentTimes(
      segments,
      segmentMetrics
        .filter((m) => (m.durationSeconds ?? 0) > 0)
        .map((m) => ({
          from_stop_id: m.fromStopId,
          to_stop_id: m.toStopId,
          travel_time_seconds: m.durationSeconds!,
          source_id: 'baidu-transit-direction'
        }))
    ).segments;
  }
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
    await applySegmentDistances(outDir, segmentMetrics, stations);
  }
  if (transferWalks.size > 0) {
    await applyTransferDistances(outDir, transferWalks);
  }

  if (!opts.skipFares) {
    console.log('  compute OD fares from the official tariff over planner mileage');
    await computeAndWriteFares(outDir);
  }

  // Re-stamp quality after the planner distances, transfer walks and fares
  // land: `writeCanonical` computed it before those patches.
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

/**
 * Apply the planner's in-vehicle km to `segments.json`.
 *
 * The fare ladder reads these distances, so a planner miss must still be
 * labelled: the straight-line estimate the writer left in place is replaced by
 * the documented ×1.25 detour factor and marked as such.
 */
async function applySegmentDistances(
  dataDir: string,
  metrics: HarvestedSegmentMetric[],
  stations: { id: string; location?: { lon: number; lat: number } }[]
): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const segmentsPath = join(dataDir, 'segments.json');
  const segDoc = JSON.parse(await readFile(segmentsPath, 'utf-8')) as {
    generated_at?: string;
    records: {
      line_id: string;
      from_stop_id: string;
      to_stop_id: string;
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  const locById = new Map(stations.map((s) => [s.id, s.location] as const));
  const metersByPair = new Map<string, number | null>(
    metrics.map(
      (m) =>
        [
          `${m.lineId}|${[m.fromStationId, m.toStationId].sort().join('|')}`,
          m.distanceMeters ?? null
        ] as const
    )
  );
  let applied = 0;
  let fallback = 0;
  for (const seg of segDoc.records) {
    const key = `${seg.line_id}|${[seg.from_station_id, seg.to_station_id].sort().join('|')}`;
    const meters = metersByPair.get(key);
    if (meters != null && meters > 0) {
      seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
      applied++;
      continue;
    }
    const a = locById.get(seg.from_station_id);
    const b = locById.get(seg.to_station_id);
    if (!a || !b) continue;
    const km = haversineKm(a, b) * 1.25;
    if (!(km > 0)) continue;
    seg.distance_km = Math.round(km * 1000) / 1000;
    seg.extras = { ...(seg.extras ?? {}), distance_source: 'haversine-detour' };
    fallback++;
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(`  segment distances applied: ${applied} planner, ${fallback} haversine fallback`);
}

/** Apply the measured station-hall walk distance to `transfers.json`. */
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
    t.extras = {
      ...(t.extras ?? {}),
      walk_distance_source: 'baidu-transit-station-hall-walk'
    };
    applied++;
  }
  doc.generated_at = new Date().toISOString();
  await writeFile(transfersPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  console.log(`  transfer walk distances applied: ${applied}`);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runChangchunNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipGeocode: process.argv.includes('--skip-geocode'),
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipTransferWalks: process.argv.includes('--skip-transfer-walks')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
