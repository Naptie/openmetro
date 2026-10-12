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
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { fetchUrumqiSources } from './fetch.js';
import { URUMQI_LINES } from './lines.js';
import { normalizeUrumqi } from './normalize.js';
import { harvestSegmentMetrics, type SegmentPairQuery } from './segments.js';
import { harvestStationTimetables } from './timetables.js';

export interface UrumqiNormalizeOptions {
  /** Repository root containing `data/cn-urumqi`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair segment-time/distance harvest (dev runs). */
  skipSegmentMetrics?: boolean;
}

export async function runUrumqiNormalize(opts: UrumqiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-urumqi');

  const sources = await fetchUrumqiSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Ürümqi first/last trains, segment metrics and fares are harvested via Baidu Direction v2 (the operator publishes timetable and fares only as static images; no OCR).'
    );
  }

  const amapByLineName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );

  // First/last trains, per line, validated boarding per leg (see timetables.ts).
  const harvestedRows = new Map<string, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  const coordsByLine = new Map<string, BaiduStationRef[]>();
  for (const cfg of URUMQI_LINES) {
    const amap = amapByLineName.get(cfg.amapName);
    const stations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (stations.length < 2) continue;

    const coordsByFold = new Map<string, { lon: number; lat: number }>();
    for (const st of amap?.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coordsByFold.set(n, { lon, lat });
    }
    const refs: BaiduStationRef[] = stations
      .map((name) => ({ name, ...(coordsByFold.get(name) ?? { lon: 0, lat: 0 }) }))
      .filter((r) => r.lon !== 0 && r.lat !== 0);
    coordsByLine.set(cfg.slug, refs);
    if (refs.length < 2) {
      console.log(`    ${cfg.short}: skip Baidu harvest (no coords)`);
      continue;
    }

    console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
    const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 380, retries: 1 });
    const withTimes = rows.filter((r) => r.downFirst || r.downLast || r.upFirst || r.upLast).length;
    if (withTimes < Math.ceil(refs.length * 0.8)) {
      throw new Error(
        `${cfg.short}: Baidu harvest covered only ${withTimes}/${refs.length} stations with times — refusing to write partial timetables`
      );
    }
    console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
    harvestedRows.set(cfg.slug, rows);
  }

  const canonical = normalizeUrumqi(sources, harvestedRows);

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '乌鲁木齐',
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

  // One interchange exists (国际机场, 1号线 ↔ 机场捷运); no operator-published
  // walk times, so the routing default applies until the gapfill layer
  // measures the walk from a cross-system planner route.
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  let segments = canonical.segments;

  // Planner-measured in-vehicle times/distances per adjacent pair, validated
  // to board and alight exactly at the pair's stops (see segments.ts).
  let segmentMetrics = new Map<string, { duration: number | null; meters: number | null }>();
  if (!opts.skipSegmentMetrics) {
    const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
    const stationById = new Map(canonical.stations.map((s) => [s.id, s] as const));
    const coordsBySlug = new Map<string, Map<string, { lon: number; lat: number }>>();
    for (const [slug, refs] of coordsByLine) {
      coordsBySlug.set(slug, new Map(refs.map((r) => [r.name, { lon: r.lon, lat: r.lat }])));
    }
    const cfgByAmap = new Map(URUMQI_LINES.map((c) => [c.amapName, c] as const));
    const queries: SegmentPairQuery[] = [];
    const seenPairs = new Set<string>();
    for (const pattern of canonical.patterns) {
      const line = canonical.lines.find((l) => l.id === pattern.line_id);
      const amapName = line?.source_ids?.find((s) => s.source === 'amap-subway-6501')?.id;
      const cfg = amapName ? cfgByAmap.get(amapName) : undefined;
      if (!line || !cfg) continue;
      for (let i = 0; i + 1 < pattern.stop_ids.length; i++) {
        const a = stopById.get(pattern.stop_ids[i]!);
        const b = stopById.get(pattern.stop_ids[i + 1]!);
        if (!a || !b) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const sa = stationById.get(a.station_id);
        const sb = stationById.get(b.station_id);
        const ca = sa?.name ? coordsBySlug.get(cfg.slug)?.get(sa.name) : undefined;
        const cb = sb?.name ? coordsBySlug.get(cfg.slug)?.get(sb.name) : undefined;
        if (!sa || !sb || !ca || !cb) continue;
        queries.push({
          line: cfg,
          fromStopId: a.id,
          toStopId: b.id,
          from: { name: sa.name, lon: ca.lon, lat: ca.lat },
          to: { name: sb.name, lon: cb.lon, lat: cb.lat }
        });
      }
    }
    console.log(`  harvest ${queries.length} adjacent-pair segment metrics via Baidu Direction v2`);
    const metrics = await harvestSegmentMetrics(baiduAk, queries, { delayMs: 380, retries: 1 });
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

  // last_train diffs are a free by-product of the first/last harvest; the
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
    // Planner in-vehicle km are also the best distance basis; apply from the
    // same measurements (haversine already covered the misses above).
    await applySegmentDistances(outDir, segmentMetrics);
  }

  if (!opts.skipFares) {
    console.log('  harvest OD fares via Baidu Direction planner quotes');
    await computeAndWriteFares(outDir, baiduAk);
  }

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

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runUrumqiNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipSegmentMetrics: process.argv.includes('--skip-segments')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
