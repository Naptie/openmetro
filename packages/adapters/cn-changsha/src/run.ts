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
  pinyinToEnglish,
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { fetchChangshaSources } from './fetch.js';
import { CHANGSHA_LINES } from './lines.js';
import { normalizeChangsha } from './normalize.js';
import { harvestSegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestTransferWalks, type TransferCandidate, type TransferStopRef } from './transfers.js';

export interface ChangshaNormalizeOptions {
  /** Repository root containing `data/cn-changsha`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair segment metric harvest (dev runs). */
  skipSegmentMetrics?: boolean;
  /** Skip the Baidu station-hall transfer walk harvest (dev runs). */
  skipTransferWalks?: boolean;
  /** Skip the Wikidata English-name lookup (dev runs). */
  skipEnglishNames?: boolean;
}

export async function runChangshaNormalize(opts: ChangshaNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-changsha');

  const sources = await fetchChangshaSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Changsha segment times, segment distances, transfer walks and the fare cross-check are measured with the Baidu Direction v2 planner (the operator publishes no per-segment metrics, no distances and no transfer walk times).'
    );
  }

  const canonical = normalizeChangsha({ sources });

  // ---- English names --------------------------------------------------------
  // AMap publishes a real English name for every Changsha station
  // (`Wuyi Square`, `Beichen Delta`, `Changsha University`), while
  // Wikidata's labels for these stations are untranslated romanisations
  // (`Wu Yi Guang Chang`, `Bei Chen San Jiao Zhou`). The published name
  // therefore wins and Wikidata only fills the remaining gaps — the same
  // shape as `cn-hongkong`, where MTR publishes no English name at all.
  let stations = applyEnglishFallbacks(canonical.stations, 'amap');
  if (!opts.skipEnglishNames) {
    const enFill = await fillStationEnglishNames(stations);
    stations = enFill.stations;
    console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  }
  stations = applyEnglishFallbacks(stations, 'pinyin');

  // ---- Coordinates ----------------------------------------------------------
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    await fillCoordinates(stations, {
      city: '长沙',
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
  const cfgByLineId = new Map<string, (typeof CHANGSHA_LINES)[number]>(
    CHANGSHA_LINES.map((c) => [`cn-changsha-line-${c.slug}`, c] as const)
  );
  const stationById = new Map(stations.map((s) => [s.id, s] as const));
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
  if (!opts.skipTransferWalks) {
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
  const segmentMetrics = new Map<string, { duration: number | null; meters: number | null }>();
  if (!opts.skipSegmentMetrics) {
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
    for (const m of metrics) {
      segmentMetrics.set([m.fromStopId, m.toStopId].sort().join('|'), {
        duration: m.durationSeconds,
        meters: m.distanceMeters
      });
    }
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

  // The official first/last table yields last-train diffs for every segment;
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

/**
 * Fill the English names that are still missing, from one source.
 *
 * `amap` uses the English name the AMap subway dataset publishes; `pinyin`
 * uses the operator's romanisation. A trailing " station" is dropped unless
 * the Chinese name itself ends with 站 — the same rule
 * `core.fillStationEnglishNames` applies to the Wikidata labels.
 */
function applyEnglishFallbacks<T extends { names: { zh: string; en: string }; extras?: unknown }>(
  stations: T[],
  source: 'amap' | 'pinyin'
): T[] {
  return stations.map((station) => {
    if (station.names.en.trim()) return station;
    const extras = (station.extras ?? {}) as {
      amap_name_en?: string;
      pinyin?: string;
    };
    const raw =
      source === 'amap'
        ? (extras.amap_name_en ?? '').trim()
        : (pinyinToEnglish(extras.pinyin) ?? '');
    if (!raw || !/[A-Za-z]/.test(raw)) return station;
    const en =
      / station$/i.test(raw) && !station.names.zh.endsWith('站')
        ? raw.replace(/ station$/i, '')
        : raw;
    return { ...station, names: { ...station.names, en } };
  });
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
  runChangshaNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipGeocode: process.argv.includes('--skip-geocode'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipTransferWalks: process.argv.includes('--skip-transfer-walks'),
    skipEnglishNames: process.argv.includes('--skip-english-names')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
