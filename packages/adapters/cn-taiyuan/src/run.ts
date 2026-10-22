import { join } from 'node:path';
import {
  deriveTransfers,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  findRepoRoot,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';

import { createTaiyuanFareSpec, type TaiyuanPlannerKey } from './fares.js';
import { fetchAmapSubway, fetchOfficialLines, fetchTicketGuide } from './fetch.js';
import { normalizeTaiyuan } from './normalize.js';
import {
  applyTaiyuanSegmentMetrics,
  collectTaiyuanSegmentMetrics,
  collectTaiyuanTransferWalks
} from './times.js';

export interface TaiyuanNormalizeOptions {
  /** Repository root containing `data/cn-taiyuan`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip live OD fare harvest. */
  skipFares?: boolean;
  /** Skip the official route-planner segment metrics harvest. */
  skipSegmentTimes?: boolean;
  /** Skip the official route-planner transfer-walk provenance harvest. */
  skipTransferWalks?: boolean;
}

export async function runTaiyuanNormalize(opts: TaiyuanNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-taiyuan');

  console.log('  fetch tymetro.ltd /api/lines');
  const officialLines = await fetchOfficialLines();
  console.log('  fetch AMap subway 1401_drw_taiyuan.json');
  const amap = await fetchAmapSubway();
  await fetchTicketGuide();

  const canonical = normalizeTaiyuan({ officialLines, amap });

  // ── Planner station references (AMap POI id → coordinates) ──
  const plannerByPoiid = new Map<string, TaiyuanPlannerKey>();
  const plannerByStationId = new Map<string, TaiyuanPlannerKey>();
  for (const st of canonical.stations) {
    const extras = st.extras as { amap_poiid?: string } | undefined;
    const poiid = extras?.amap_poiid;
    if (!poiid || !st.location) continue;
    const key: TaiyuanPlannerKey = {
      name: st.name,
      lon: st.location.lon,
      lat: st.location.lat,
      poiid
    };
    plannerByPoiid.set(poiid, key);
    plannerByStationId.set(st.id, key);
  }
  const plannerOfStop = (stopId: string): TaiyuanPlannerKey | undefined => {
    const stop = canonical.stops.find((s) => s.id === stopId);
    return stop ? plannerByStationId.get(stop.station_id) : undefined;
  };

  // ── Segment metrics from the operator's own route planner ──
  let segments = canonical.segments;
  if (!opts.skipSegmentTimes) {
    const metrics = await collectTaiyuanSegmentMetrics({
      stops: canonical.stops,
      patterns: canonical.patterns,
      stationOf: plannerOfStop,
      concurrency: 4,
      delayMs: 80
    });
    const applied = applyTaiyuanSegmentMetrics(segments, metrics.segments);
    segments = applied.segments;
    console.log(
      `  official segment metrics: fetched=${metrics.fetched} failed=${metrics.failed} applied=${applied.applied}/${segments.length}`
    );
  }

  // ── Coordinates ──
  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    const enFill = await fillStationEnglishNames(canonical.stations);
    stations = enFill.stations;
    console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
    stations = await fillCoordinates(stations, {
      city: '太原',
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
      onOfficialMatch: () => officialMatched++,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
  }

  // ── Transfers ──
  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  let transfers = deriveTransfers(stations, canonical.stops, [], {
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
          source_id: t.source_id ?? 'tymetro-routing-default'
        }
  );

  // ── Official planner's description of the in-station interchange walk ──
  // The operator publishes the walk path and its length, but its `foottime`
  // folds in the wait for the departing train (it varies with the arrival and
  // departure direction at 大南门), so the walking *time* is left to the core
  // `gapfill` layer, which measures the walk through the station.
  if (!opts.skipTransferWalks) {
    const linesByStation = new Map<string, Set<string>>();
    for (const s of canonical.stops) {
      const set = linesByStation.get(s.station_id) ?? new Set<string>();
      set.add(s.line_id);
      linesByStation.set(s.station_id, set);
    }
    const hubs = [...linesByStation.entries()]
      .filter(([, lines]) => lines.size >= 2)
      .map(([station_id, lines]) => ({ station_id, lineIds: [...lines] }));
    if (hubs.length > 0) {
      const walks = await collectTaiyuanTransferWalks({
        hubs,
        probeOf: (stationId, lineId) => {
          // A stop one hop away from the hub on the given line, so the
          // planner routes through the hub and reports its transfer walk.
          const hubStop = canonical.stops.find(
            (s) => s.station_id === stationId && s.line_id === lineId
          );
          if (!hubStop) return undefined;
          const pattern = canonical.patterns.find((p) => p.line_id === lineId);
          if (!pattern) return undefined;
          const i = pattern.stop_ids.indexOf(hubStop.id);
          const neighbour =
            i >= 0 ? (pattern.stop_ids[i + 1] ?? pattern.stop_ids[i - 1]) : undefined;
          if (!neighbour) return undefined;
          const stop = canonical.stops.find((s) => s.id === neighbour);
          return stop ? plannerByStationId.get(stop.station_id) : undefined;
        },
        concurrency: 2,
        delayMs: 120
      });
      const walkByKey = new Map<string, (typeof walks)[number]>();
      for (const w of walks) {
        walkByKey.set(`${w.station_id}|${w.from_line_id}|${w.to_line_id}`, w);
      }
      transfers = transfers.map((t) => {
        const w = walkByKey.get(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`);
        if (!w) return t;
        return {
          ...t,
          extras: {
            ...(t.extras ?? {}),
            official_planner_walk: {
              walk_length_m: w.walk_length_m,
              walk_path_length_m: w.walk_path_length_m,
              planner_foot_time_s: w.planner_foot_time_s,
              note: '官网规划器发布的站内换乘路径长度；foottime 含候车，未作为步行时间使用',
              geometry: w.walk_geometry
            }
          }
        };
      });
      console.log(`  official transfer walks: ${walks.length} measured`);
    }
  }

  // ── Timetables ──
  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  // Any hop the planner could not measure falls back to the official
  // timetable deltas and then to the distance model.
  segments = fillMissingSegmentTimes(segments, canonical.patterns, canonical.stops, timetables);

  console.log(
    `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
  );
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

  if (!opts.skipFares) {
    console.log('  harvest official OD fares');
    const spec = createTaiyuanFareSpec(plannerByPoiid);
    await syncFares({ dataDir: outDir }, spec, { concurrency: 6, delay: 60 });
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
  console.log('segments with distance:', segments.filter((s) => s.distance_km != null).length);
  console.log('transfers:', transfers.length);
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runTaiyuanNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipSegmentTimes: process.argv.includes('--skip-segment-times')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
