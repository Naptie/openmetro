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
  type LineEncoded,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';

import { fetchShanghaiSources } from './fetch.js';
import { normalize, type ShStationInfo } from './normalize.js';
import { collectShanghaiPlannerTimes } from './times.js';

/** Shanghai has no city-specific station corrections yet. */
export const transformStations: TransformStations = (stations) => stations;

export interface ShanghaiNormalizeOptions {
  root?: string;
  /** Skip live plantrip harvest (offline / partial rebuilds). */
  skipPlannerTimes?: boolean;
}

export async function runShanghaiNormalize(opts: ShanghaiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-shanghai');

  const {
    nameToCodes,
    lines: linesMeta,
    lineSequences,
    stations: stationRecords,
    fltimeRows,
    lineNotes
  } = await fetchShanghaiSources();

  const stationsByCode: Record<string, ShStationInfo[]> = {};
  for (const [code, infos] of Object.entries(stationRecords as Record<string, ShStationInfo[]>)) {
    stationsByCode[code] = infos;
  }

  const canonical = normalize({
    lineSequences,
    lines: linesMeta,
    stations: stationsByCode,
    fltimeRows,
    lineNotes,
    nameToCodes
  });

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.zh
  });

  // Station location is left unset here; fillCoordinates places them from
  // AMap first, then official stationInfo GCJ-02, then Overpass/Photon.
  let subwayMatched = 0;
  let officialMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  const stations = transformStations(
    await fillCoordinates(canonical.stations, {
      city: '上海',
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
      onSubwayMatch: () => subwayMatched++,
      onOfficialMatch: () => officialMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    }),
    { network: canonical.network.id, city: '上海' }
  );

  // Planner harvest: adjacent ODs for segment minutes + targeted ODs for
  // transferStationTime. Independent of the full fares matrix.
  let segments = canonical.segments;
  let transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });
  if (!opts.skipPlannerTimes) {
    console.log('  harvest plantrip segment/transfer times');
    const stopCodeById = new Map(
      canonical.stops.filter((s) => s.source_id).map((s) => [s.id, s.source_id as string])
    );
    const stationNameById = new Map(canonical.stations.map((s) => [s.id, s.name]));
    const codesByStationId = new Map<string, string[]>();
    for (const stop of canonical.stops) {
      const code = stop.source_id as string | undefined;
      if (!code) continue;
      const list = codesByStationId.get(stop.station_id) ?? [];
      if (!list.includes(code)) list.push(code);
      codesByStationId.set(stop.station_id, list);
    }
    const harvested = await collectShanghaiPlannerTimes({
      patterns: canonical.patterns,
      stops: canonical.stops,
      transfers: transfers,
      stopCode: (id) => stopCodeById.get(id),
      stationName: (id) => stationNameById.get(id),
      stationCodes: (id) => codesByStationId.get(id) ?? [],
      defaultWalkSeconds: canonical.network.routing?.default_transfer_seconds
    });
    const seg = applyHarvestedSegmentTimes(segments, harvested.segments);
    const xfer = applyHarvestedTransferTimes(transfers, harvested.transfers);
    segments = seg.segments;
    transfers = xfer.transfers;
    console.log(`  applied planner times: ${seg.applied} segments, ${xfer.applied} transfers`);
  }

  // Fallback only: last_train derivation for planner/source gaps.
  // Straight-line distance from coordinates + speed-model times for gaps
  // (never overwrite source/planner/last_train values).
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  const beforeFill = segments;
  const filledAll = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );
  segments = beforeFill.map((s, i) => {
    if (s.travel_time_seconds != null && s.travel_time_seconds > 0) return s;
    return filledAll[i] ?? s;
  });

  await writeCanonical(outDir, 'cn-shanghai', {
    network: canonical.network,
    lines,
    stations: stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables: canonical.timetables
  });

  console.log('lines:', lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via subway:', subwayMatched);
  console.log('  via official:', officialMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
  console.log('stops:', canonical.stops.length);
  console.log('segments:', segments.length);
  console.log('transfers:', transfers.length);
  console.log('timetables:', canonical.timetables.length);
  console.log('segments by time source:');
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log(' ', bySrc);
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runShanghaiNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
