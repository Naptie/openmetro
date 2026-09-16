import { join } from 'node:path';
import {
  applyHarvestedSegmentTimes,
  applyHarvestedTransferTimes,
  enrichLineNamesFromWikidata,
  fillCoordinates,
  type LineEncoded,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';
import { fetchBeijingSources } from './fetch.js';
import { normalize } from './normalize.js';
import { collectBeijingPlannerTimes } from './times.js';

/** Beijing has no city-specific station corrections yet. */
export const transformStations: TransformStations = (stations) => stations;

export interface BeijingNormalizeOptions {
  /** Repository root containing `data/cn-bj`. */
  root?: string;
  /** Skip live searchstartend harvest (offline / partial rebuilds). */
  skipPlannerTimes?: boolean;
}

export async function runBeijingNormalize(opts: BeijingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-bj');

  const sources = await fetchBeijingSources();
  const canonical = normalize({
    beijingXml: sources.beijingXml,
    stationsXml: sources.stationsXml,
    apiStationsJson: sources.apiStations,
    timeinfos: sources.timeinfos,
    interchangeXml: sources.interchangeXml
  });

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.name
  });

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  const stations = transformStations(
    await fillCoordinates(canonical.stations, {
      city: '北京',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    }),
    { network: canonical.network.id, city: '北京' }
  );

  let segments = canonical.segments;
  let transfers = canonical.transfers;
  if (!opts.skipPlannerTimes) {
    console.log('  harvest searchstartend segment/transfer times');
    const nameByStationId = new Map(canonical.stations.map((s) => [s.id, s.name]));
    const nameByStopId = new Map(
      canonical.stops.map((s) => [s.id, nameByStationId.get(s.station_id)])
    );
    const harvested = await collectBeijingPlannerTimes({
      patterns: canonical.patterns,
      stops: canonical.stops,
      transfers: canonical.transfers,
      stopName: (stopId) => nameByStopId.get(stopId)
    });
    const seg = applyHarvestedSegmentTimes(segments, harvested.segments);
    const xfer = applyHarvestedTransferTimes(transfers, harvested.transfers);
    segments = seg.segments;
    transfers = xfer.transfers;
    console.log(`  applied planner times: ${seg.applied} segments, ${xfer.applied} transfers`);
  }

  await writeCanonical(outDir, 'cn-bj', {
    network: canonical.network,
    lines,
    stations,
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
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
  console.log('stops:', canonical.stops.length);
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
  runBeijingNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
