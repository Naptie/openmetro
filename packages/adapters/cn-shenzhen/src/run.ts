import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyHarvestedSegmentTimes,
  applyHarvestedTransferTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  findRepoRoot,
  type LineEncoded,
  type StationEncoded,
  syncFares,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';

import { fareSpec } from './fares.js';
import { fetchMinTime, fetchShenzhenSources, fetchZdxxStation } from './fetch.js';
import { normalize } from './normalize.js';
import { collectShenzhenPlannerTimes, collectShenzhenTransferTimes } from './times.js';
import { buildTimetablesFromZdxx } from './timetable-zdxx.js';

export const transformStations: TransformStations = (stations) => stations;

export interface ShenzhenNormalizeOptions {
  root?: string;
  skipPlannerTimes?: boolean;
  skipGeocode?: boolean;
  skipFares?: boolean;
  skipEnTimetables?: boolean;
  /** Official station-detail API (`POST /zdxx`) is the primary timetable source. */
  skipZdxxTimetables?: boolean;
}

export async function runShenzhenNormalize(opts: ShenzhenNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-shenzhen');

  const sources = await fetchShenzhenSources({ skipEnTimetables: opts.skipEnTimetables });
  const canonical = normalize(sources);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

  let subwayMatched = 0;
  let officialMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    stations = transformStations(
      await fillCoordinates(canonical.stations, {
        city: '深圳',
        stops: canonical.stops,
        lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
        officialLocations: canonical.officialLocations,
        knownLocations: [
          {
            name: '宝安客运站',
            location: { lon: 113.883674, lat: 22.589332, crs: 'gcj02' },
            source: 'known'
          }
        ],
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
        onOfficialMatch: () => officialMatched++,
        onOverpassMatch: () => overpassMatched++,
        onGeocode: () => geocoded++,
        onSpeedValidate: (report) => {
          if (!report.ok) {
            console.log(
              `  speed-validate FAIL ${report.station_name ?? report.station_id}: ` +
                (report.violations[0]?.detail ?? '')
            );
          }
        }
      }),
      { network: canonical.network.id, city: '深圳' }
    );
  } else {
    try {
      const prev = JSON.parse(await readFile(join(outDir, 'stations.json'), 'utf-8')) as {
        records?: StationEncoded[];
      };
      const prevById = new Map((prev.records ?? []).map((s) => [s.id, s] as const));
      stations = canonical.stations.map((s) => {
        const old = prevById.get(s.id);
        if (!old?.location) return s;
        return { ...s, location: old.location, schematic: old.schematic ?? s.schematic };
      });
    } catch {
      // no previous dataset
    }
  }
  stations = transformStations(stations, { network: canonical.network.id, city: '深圳' });

  const codeByStopId = new Map<string, string>();
  const stationIdByStopId = new Map<string, string>();
  const stopByCode = new Map<string, string>();
  const patternIdByLine = new Map<string, string>();
  for (const stop of canonical.stops) {
    stationIdByStopId.set(stop.id, stop.station_id);
    const code = stop.source_id;
    if (code) {
      codeByStopId.set(stop.id, code);
      if (!stopByCode.has(code)) stopByCode.set(code, stop.id);
    }
  }
  for (const p of canonical.patterns) {
    if (!patternIdByLine.has(p.line_id)) patternIdByLine.set(p.line_id, p.id);
  }
  const stationNameById = new Map(stations.map((s) => [s.id, s.name]));
  const stationIdByCode = new Map<string, string>();
  for (const [code, stopId] of stopByCode) {
    const sid = stationIdByStopId.get(stopId);
    if (sid) stationIdByCode.set(code, sid);
  }

  // Primary timetable source: official station detail `POST /zdxx`.
  // Schema mapping: Mon–Fri=workDay, Sat–Sun=dayoff as length-7 arrays;
  // holiday calendar lives in extras (schema has no holiday slot).
  let zdxxTimetableCount = 0;
  if (!opts.skipZdxxTimetables) {
    console.log('  fetch official station detail timetables (/zdxx)');
    // Query every official code: interchange arms often return empty on the
    // first code (e.g. 国展 1230 empty / 2003 has Line 20).
    const codes: string[] = [];
    for (const st of stations) {
      const official = (st.extras as { official_codes?: string[] } | undefined)?.official_codes;
      for (const code of official ?? []) {
        if (code && !codes.includes(code)) codes.push(code);
      }
    }
    const zdxxRecords = new Map<string, Awaited<ReturnType<typeof fetchZdxxStation>>>();
    let nextCode = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function zdxxWorker(): Promise<void> {
      while (true) {
        const i = nextCode++;
        if (i >= codes.length) return;
        const code = codes[i];
        zdxxRecords.set(code, await fetchZdxxStation(code));
        await sleep(120);
      }
    }
    await Promise.all(Array.from({ length: 3 }, () => zdxxWorker()));
    // Drop empty payloads so the builder does not prefer a blank first code.
    for (const [code, resp] of zdxxRecords) {
      if (!resp || (!resp.siteName && !resp.workDay?.length && !resp.dayoff?.length)) {
        zdxxRecords.delete(code);
      }
    }
    const zdxxTt = buildTimetablesFromZdxx({
      networkId: canonical.network.id,
      records: zdxxRecords,
      stations,
      stops: canonical.stops,
      patterns: canonical.patterns
    });
    zdxxTimetableCount = zdxxTt.length;
    console.log(`  zdxx timetables: ${zdxxTt.length} (stations queried: ${codes.length})`);
    if (zdxxTt.length > 0) {
      // Replace EN/planner-derived tables with official per-station detail.
      canonical.timetables = zdxxTt;
    }
  }

  let transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  let segments = canonical.segments;

  // Segment-time priority: official source (none from map JS) → MinTimeJson
  // planner → last_train derivation → estimated. Run planner before last-train
  // fill so derivation never pre-empts a measured planner hop.
  const useZdxxOnly = zdxxTimetableCount > 0;
  if (!opts.skipPlannerTimes) {
    console.log('  harvest MinTimeJson adjacent segment times');
    const harvested = await collectShenzhenPlannerTimes({
      patterns: canonical.patterns,
      stops: canonical.stops,
      transfers,
      codeOf: (stopId) => codeByStopId.get(stopId),
      stationIdOf: (stopId) => stationIdByStopId.get(stopId),
      stationName: (stationId) => stationNameById.get(stationId),
      patternIdByLine
    });
    const seg = applyHarvestedSegmentTimes(segments, harvested.segments);
    segments = seg.segments;
    console.log(`  applied planner segment times: ${seg.applied}/${segments.length}`);

    // Prefer official /zdxx tables; only fall back to planner TT hints when needed.
    const haveTt = new Set(
      canonical.timetables.map((t) => `${t.stop_id}|${t.destination_stop_id}|${t.line_id}`)
    );
    const extraTt = [];
    const stopById = new Map(canonical.stops.map((s) => [s.id, s]));
    if (!useZdxxOnly) {
      for (const hint of harvested.timetableHints) {
        if (!hint.station_id || !hint.stop_id || !hint.line_id || !hint.pattern_id) continue;
        if (!hint.first_train || !hint.last_train) continue;
        const destStopId = hint.destination_stop_id;
        const key = `${hint.stop_id}|${destStopId}|${hint.line_id}`;
        if (haveTt.has(key)) continue;
        const destStop = stopById.get(destStopId);
        if (!destStop || destStop.line_id !== hint.line_id) continue;
        haveTt.add(key);
        extraTt.push({
          id: `${canonical.network.id}-${hint.stop_id}-to-${destStopId}-planner`,
          station_id: hint.station_id,
          stop_id: hint.stop_id,
          line_id: hint.line_id,
          station_code: hint.station_code,
          source_id: 'szmc-mintime',
          destination_stop_id: destStopId,
          pattern_id: hint.pattern_id,
          first_train: [hint.first_train],
          last_train: [hint.last_train],
          service: 'all_days',
          direction_type: 'linear' as const
        });
      }
    }

    console.log('  harvest MinTimeJson transfer walk times');
    const xferHarvest = await collectShenzhenTransferTimes({
      transfers,
      stops: canonical.stops,
      patterns: canonical.patterns,
      codeOf: (stopId) => codeByStopId.get(stopId),
      stationName: (stationId) => stationNameById.get(stationId)
    });
    const xfer = applyHarvestedTransferTimes(transfers, xferHarvest);
    transfers = xfer.transfers;
    console.log(`  applied planner transfer times: ${xfer.applied}/${transfers.length}`);

    if (!useZdxxOnly) {
      if (extraTt.length > 0) {
        canonical.timetables = [...canonical.timetables, ...extraTt];
        console.log(`  planner timetable hints merged: +${extraTt.length}`);
      }

      // Fallback fill for operating stops still missing any timetable.
      const stationsWithTt = new Set(canonical.timetables.map((t) => t.station_id));
      const patternByLine = new Map(canonical.patterns.map((p) => [p.line_id, p]));
      const missingStops = canonical.stops.filter((stop) => {
        const st = stations.find((s) => s.id === stop.station_id);
        return st?.status === 'operating' && !stationsWithTt.has(stop.station_id);
      });
      console.log(`  fill missing timetables via planner: ${missingStops.length} stops`);
      const filled: typeof canonical.timetables = [];
      const sleepFill = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const stop of missingStops) {
        const pattern = patternByLine.get(stop.line_id);
        if (!pattern) continue;
        const code = codeByStopId.get(stop.id);
        if (!code) continue;
        const termini = [pattern.origin_stop_id, pattern.terminal_stop_id].filter(
          (id) => id && id !== stop.id
        );
        for (const destStopId of termini) {
          const destCode = codeByStopId.get(destStopId);
          if (!destCode) continue;
          const resp = await fetchMinTime(code, destCode, 0);
          await sleepFill(160);
          if (!resp) continue;
          const legs = resp.lineList ?? [];
          const firstLeg = legs.find((l) => String(l.code || '').trim() === code) ?? legs[0];
          const first = firstLeg?.firstTime?.trim();
          const last = firstLeg?.endTime?.trim();
          const toHH = (v?: string) => {
            if (!v || v === '--') return undefined;
            const m = /^(\d{1,2}):(\d{2})/.exec(v);
            return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
          };
          const f = toHH(first);
          const l = toHH(last);
          const key = `${stop.id}|${destStopId}|${stop.line_id}`;
          if (haveTt.has(key)) continue;
          if (f || l) {
            haveTt.add(key);
            filled.push({
              id: `${canonical.network.id}-${stop.id}-to-${destStopId}-planner-fill`,
              station_id: stop.station_id,
              stop_id: stop.id,
              line_id: stop.line_id,
              station_code: code,
              source_id: 'szmc-mintime',
              destination_stop_id: destStopId,
              pattern_id: pattern.id,
              first_train: f ? [f] : [],
              last_train: l ? [l] : [],
              service: 'all_days',
              direction_type: 'linear' as const
            });
            break;
          }
        }
      }
      if (filled.length > 0) {
        canonical.timetables = [...canonical.timetables, ...filled];
        console.log(`  planner filled timetables: +${filled.length}`);
      }
    }
  }

  // Priority fallback after planner: last_train → estimated for remaining gaps only.
  const beforeFill = segments;
  const filledSegs = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );
  segments = beforeFill.map((s, i) => {
    if (s.travel_time_seconds != null && s.travel_time_seconds > 0) return s;
    return filledSegs[i] ?? s;
  });

  // Distance from coordinates + speed-model times (core helpers).
  segments = fillStraightLineDistances(segments, stations, { minKm: 0.05, maxKm: 30 });
  segments = estimateTimesFromDistanceSpeed(segments);

  await writeCanonical(outDir, 'cn-shenzhen', {
    network: canonical.network,
    lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables: canonical.timetables
  });

  if (!opts.skipFares) {
    console.log('  harvest full OD fares via MinTimeJson');
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 8, delay: 80 });
  }

  console.log('lines:', lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via subway:', subwayMatched);
  console.log('  via official:', officialMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
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
  console.log('timetables:', canonical.timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runShenzhenNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
