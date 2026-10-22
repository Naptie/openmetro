import { join } from 'node:path';
import {
  applyDerivedTimes,
  type BaiduStationRef,
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
import { harvestSegmentMetrics, type SegmentMetric, type SegmentPairQuery } from './distances.js';
import { computeAndWriteFares } from './fares.js';
import { fetchHohhotSources } from './fetch.js';
import { HOHHOT_LINES } from './lines.js';
import { normalizeHohhot, officialStationName } from './normalize.js';
import {
  checkOfficialTimetableAgreement,
  deriveSegmentTimesBothDirections,
  harvestStationTimetables,
  type LineHarvest
} from './timetables.js';

export interface HohhotNormalizeOptions {
  /** Repository root containing `data/cn-hohhot`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
  /** Skip the Baidu per-segment track-distance harvest (dev runs). */
  skipSegmentMetrics?: boolean;
}

export async function runHohhotNormalize(opts: HohhotNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-hohhot');

  const sources = await fetchHohhotSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Hohhot first/last trains and OD fares are harvested via Baidu Direction v2 (the operator publishes timetable and fares only as static images; no OCR).'
    );
  }

  const amapByLineName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );

  // First/last trains, per line, harvested from the planner and validated
  // against the operator's published sheets (see timetables.ts).
  const harvestedRows = new Map<string, Awaited<ReturnType<typeof harvestStationTimetables>>>();
  const harvests: LineHarvest[] = [];
  for (const cfg of HOHHOT_LINES) {
    const amap = amapByLineName.get(cfg.amapName);
    const stations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (stations.length < 2) continue;

    const coordsByName = new Map<string, { lon: number; lat: number }>();
    for (const st of amap?.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coordsByName.set(n, { lon, lat });
    }
    // The planner names stations by the operator's *current* official name.
    const refs: BaiduStationRef[] = stations
      .map((name) => {
        const c = coordsByName.get(name);
        return c ? { name: officialStationName(name), lon: c.lon, lat: c.lat } : undefined;
      })
      .filter((r): r is BaiduStationRef => r != null);
    if (refs.length !== stations.length) {
      throw new Error(
        `${cfg.short}: ${stations.length - refs.length} AMap stations have no usable coordinates`
      );
    }

    if (opts.skipTimetables) {
      console.log(`    ${cfg.short}: skip Baidu first/last harvest (--skip-timetables)`);
      continue;
    }

    console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction v2`);
    const rows = await harvestStationTimetables(baiduAk, cfg, refs, { delayMs: 380, retries: 1 });
    const withTimes = rows.filter((r) => r.downFirst || r.downLast || r.upFirst || r.upLast).length;
    const downRows = rows.filter((r) => r.downFirst || r.downLast).length;
    const upRows = rows.filter((r) => r.upFirst || r.upLast).length;
    // A line of n stations has n-1 departures toward each end: the terminus
    // of a direction has no departure in it.
    if (withTimes < refs.length || downRows < refs.length - 1 || upRows < refs.length - 1) {
      const missing = rows
        .filter((r) => !(r.downFirst || r.downLast || r.upFirst || r.upLast))
        .map((r) => r.stationName);
      throw new Error(
        `${cfg.short}: Baidu harvest covered ${withTimes}/${refs.length} stations ` +
          `(${downRows}/${refs.length - 1} toward the far end, ${upRows}/${refs.length - 1} toward the near end; ` +
          `missing: ${missing.join(', ') || 'none'}) — refusing to write partial timetables`
      );
    }
    console.log(`    ${cfg.short}: ${withTimes}/${rows.length} stations with times`);
    harvestedRows.set(cfg.slug, rows);
    harvests.push({ cfg, order: refs.map((r) => r.name), rows });
  }

  if (!opts.skipTimetables) {
    checkOfficialTimetableAgreement(harvests);
  }

  const canonical = normalizeHohhot(sources, harvestedRows);

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '呼和浩特',
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

  // One interchange (新华广场, 1号线 ↔ 2号线, 十字换乘); the operator
  // publishes no transfer walk time, so the routing default applies until
  // the gapfill layer measures the walk.
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // Segment times are derived from the last-train chain: the planner reports
  // the last *departure* at each station, so the difference between
  // consecutive stations is the run time between them.
  let segments = canonical.segments;
  const derived = deriveSegmentTimesBothDirections(
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );
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

  // The network's own track distance per segment, measured along the
  // alignment from the planner's metro legs (the straight-line distance
  // understates it). The fares layer uses it to price the OD pairs the
  // planner cannot quote as a metro itinerary.
  let segmentMetrics: SegmentMetric[] = [];
  if (!opts.skipSegmentMetrics) {
    const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
    const stationById = new Map(stations.map((s) => [s.id, s] as const));
    const coordsByName = new Map<string, { lon: number; lat: number }>();
    for (const st of stations) {
      if (st.location) coordsByName.set(st.name, { lon: st.location.lon, lat: st.location.lat });
    }
    const queries: SegmentPairQuery[] = [];
    const seen = new Set<string>();
    for (const pattern of canonical.patterns) {
      for (let i = 0; i + 1 < pattern.stop_ids.length; i++) {
        const a = stopById.get(pattern.stop_ids[i]!);
        const b = stopById.get(pattern.stop_ids[i + 1]!);
        if (!a || !b) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const sa = stationById.get(a.station_id);
        const sb = stationById.get(b.station_id);
        if (!sa || !sb) continue;
        const ca = coordsByName.get(sa.name);
        const cb = coordsByName.get(sb.name);
        if (!ca || !cb) continue;
        queries.push({
          fromStopId: a.id,
          toStopId: b.id,
          from: { name: sa.name, ...ca },
          to: { name: sb.name, ...cb }
        });
      }
    }
    console.log(`  harvest ${queries.length} segment track distances via Baidu Direction v2`);
    segmentMetrics = await harvestSegmentMetrics(baiduAk, queries, { delayMs: 380, retries: 1 });
    const withDistance = segmentMetrics.filter((m) => (m.distanceMeters ?? 0) > 0).length;
    console.log(`    ${withDistance}/${segmentMetrics.length} segments measured`);
  }

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

  if (!opts.skipSegmentMetrics && segmentMetrics.length > 0) {
    // Planner-measured track distance beats the straight-line estimate.
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

/**
 * Replace the straight-line segment distance with the track distance
 * measured along the alignment. The planner's polyline runs a few percent
 * longer than the track (the airport viaduct especially); the fares layer
 * rescales each line to the published length when it applies the mileage
 * tariff.
 */
async function applySegmentDistances(dataDir: string, metrics: SegmentMetric[]): Promise<void> {
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
    const meters = metrics.find(
      (m) => [m.fromStopId, m.toStopId].sort().join('|') === key
    )?.distanceMeters;
    if (meters != null && meters > 0) {
      seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
      applied++;
    }
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(`  segment track distances applied: ${applied} planner-measured`);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runHohhotNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipGeocode: process.argv.includes('--skip-geocode')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
