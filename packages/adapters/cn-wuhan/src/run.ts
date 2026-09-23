import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  type LineEncoded,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';

import { fareSpec, writeWuhanFormulaFares } from './fares.js';
import { fetchWuhanSources } from './fetch.js';
import { normalizeWuhan } from './normalize.js';
import {
  adjacentKey,
  collectWuhanAdjacentTimes,
  collectWuhanTransferTimes,
  transferKey
} from './times.js';

export interface WuhanNormalizeOptions {
  /** Repository root containing `data/cn-wuhan`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip live adjacent-station / transfer planner harvest. */
  skipPlannerTimes?: boolean;
}

function rootOfDefault(): string {
  if (process.env.OPENMETRO_ROOT) return process.env.OPENMETRO_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'packages', 'adapters')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

/** Adjacent station pairs on each line, for official planner times. */
function collectAdjacentPairs(input: {
  stopName: Map<string, string>;
  patterns: {
    line_id: string;
    stop_ids: readonly string[];
    is_primary?: boolean;
  }[];
}): { fromName: string; toName: string; fromStopId: string; toStopId: string }[] {
  const pairs: { fromName: string; toName: string; fromStopId: string; toStopId: string }[] = [];
  const seen = new Set<string>();
  const patterns = [...input.patterns].sort((a, b) =>
    a.is_primary === b.is_primary ? 0 : a.is_primary ? -1 : 1
  );
  for (const p of patterns) {
    for (let i = 0; i < p.stop_ids.length - 1; i++) {
      const a = p.stop_ids[i]!;
      const b = p.stop_ids[i + 1]!;
      const key = [p.line_id, a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const fromName = input.stopName.get(a);
      const toName = input.stopName.get(b);
      if (!fromName || !toName) continue;
      pairs.push({ fromName, toName, fromStopId: a, toStopId: b });
    }
  }
  return pairs;
}

export async function runWuhanNormalize(opts: WuhanNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? rootOfDefault();
  const outDir = join(root, 'data/cn-wuhan');

  const sources = await fetchWuhanSources();
  const canonical = normalizeWuhan(sources);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '武汉',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
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

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'wuhanrt-routing-default'
        }
  );

  let segments = canonical.segments;

  // Official planner times for adjacent pairs (when enabled).
  if (!opts.skipPlannerTimes) {
    const adjPairs = collectAdjacentPairs({
      stopName: canonical.stopName,
      patterns: canonical.patterns
    });
    console.log(`  harvest adjacent planner times (${adjPairs.length} pairs)`);
    const planner = await collectWuhanAdjacentTimes(
      adjPairs.map((p) => ({ fromName: p.fromName, toName: p.toName })),
      { delayMs: 60 }
    );
    const byKey = new Map(planner.map((p) => [adjacentKey(p.fromName, p.toName), p]));
    segments = segments.map((seg) => {
      if (seg.travel_time_seconds != null && seg.travel_time_source === 'source') return seg;
      const fromName = canonical.stopName.get(seg.from_stop_id);
      const toName = canonical.stopName.get(seg.to_stop_id);
      if (!fromName || !toName) return seg;
      const hit = byKey.get(adjacentKey(fromName, toName));
      if (!hit?.travel_time_seconds) return seg;
      return {
        ...seg,
        travel_time_seconds: hit.travel_time_seconds,
        travel_time_source: 'planner' as const,
        distance_km: hit.distance_km ?? seg.distance_km,
        extras: {
          ...(seg.extras ?? {}),
          planner_source: hit.source,
          // quality.ts maps plantrip/mintime planner tags to official precision.
          planner_time_source: hit.source === 'route' ? 'lmap-route-mintime' : 'pathphp'
        }
      };
    });

    // Transfer walk times at major interchanges.
    const lineShort = new Map(lines.map((l) => [l.id, l.short_name]));
    const interchangePairs: {
      stationName: string;
      fromLineShort: string;
      toLineShort: string;
      fromNeighbor: string;
      toNeighbor: string;
    }[] = [];
    const byStation = new Map<
      string,
      { lineId: string; stopId: string; stationId: string; seq: number }[]
    >();
    for (const stop of canonical.stops) {
      const list = byStation.get(stop.station_id) ?? [];
      list.push({
        lineId: stop.line_id,
        stopId: stop.id,
        stationId: stop.station_id,
        seq: stop.sequence
      });
      byStation.set(stop.station_id, list);
    }
    for (const [, list] of byStation) {
      if (list.length < 2) continue;
      const stationName = canonical.stationNameById.get(list[0]!.stationId);
      if (!stationName) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const a = list[i]!;
          const b = list[j]!;
          const fromShort = lineShort.get(a.lineId) ?? '';
          const toShort = lineShort.get(b.lineId) ?? '';
          if (!fromShort || !toShort || fromShort === toShort) continue;
          // Neighbours on each line (prefer previous then next).
          const lineStops = canonical.stops
            .filter((s) => s.line_id === a.lineId)
            .sort((x, y) => x.sequence - y.sequence);
          const idx = lineStops.findIndex((s) => s.id === a.stopId);
          const fromNeighborStop = lineStops[idx - 1] ?? lineStops[idx + 1];
          const lineStopsB = canonical.stops
            .filter((s) => s.line_id === b.lineId)
            .sort((x, y) => x.sequence - y.sequence);
          const idxB = lineStopsB.findIndex((s) => s.id === b.stopId);
          const toNeighborStop = lineStopsB[idxB + 1] ?? lineStopsB[idxB - 1];
          if (!fromNeighborStop || !toNeighborStop) continue;
          const fromNeighbor = canonical.stationNameById.get(fromNeighborStop.station_id);
          const toNeighbor = canonical.stationNameById.get(toNeighborStop.station_id);
          if (!fromNeighbor || !toNeighbor) continue;
          interchangePairs.push({
            stationName,
            fromLineShort: fromShort,
            toLineShort: toShort,
            fromNeighbor,
            toNeighbor
          });
        }
      }
    }
    // Cap harvest cost: sample at most ~80 directed interchange probes.
    const capped = interchangePairs.slice(0, 80);
    if (capped.length > 0) {
      console.log(`  harvest transfer planner times (${capped.length} probes)`);
      const xfers = await collectWuhanTransferTimes(capped, { delayMs: 80 });
      const xByKey = new Map(
        xfers.map((x) => [
          transferKey(x.stationName, x.fromLineShort, x.toLineShort),
          x.walk_time_seconds
        ])
      );
      for (let i = 0; i < transfers.length; i++) {
        const t = transfers[i]!;
        if (t.source_id && t.source_id !== 'wuhanrt-routing-default') continue;
        const stationName = canonical.stationNameById.get(t.station_id);
        const fromShort = lineShort.get(t.from_line_id);
        const toShort = lineShort.get(t.to_line_id);
        if (!stationName || !fromShort || !toShort) continue;
        const hit = xByKey.get(transferKey(stationName, fromShort, toShort));
        if (hit != null) {
          transfers[i] = {
            ...t,
            walk_time_seconds: hit,
            source_id: 'wuhanrt-lmap-route-mintime',
            extras: { ...(t.extras ?? {}), planner_source: 'route' }
          };
        }
      }
    }
  }

  // Last-train derived times fill remaining gaps.
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  // Straight-line distance from coordinates + speed-model times for gaps
  // (never overwrite source/planner/last_train values).
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  console.log(
    `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
  );
  console.log(
    `  counts: lines=${lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  // Formula fares first so writeCanonical can fold them into network.quality.
  if (opts.skipFares) {
    console.log('  write formula fares (official mileage policy + coords)');
    await writeWuhanFormulaFares(outDir);
  }

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines,
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
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 8, delay: 80 });
  }

  console.log('lines:', lines.length);
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
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runWuhanNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipPlannerTimes: process.argv.includes('--skip-planner')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
