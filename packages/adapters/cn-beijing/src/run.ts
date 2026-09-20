import { join } from 'node:path';
import {
  applyHarvestedSegmentTimes,
  applyHarvestedTransferTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  fillCoordinates,
  fillMissingSegmentTimes,
  haversineKm,
  type LineEncoded,
  MODE_MAX_SPEED_KMH,
  type SegmentEncoded,
  type StationEncoded,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';
import { fetchBeijingSources } from './fetch.js';
import { normalize } from './normalize.js';
import { collectBeijingPlannerTimes } from './times.js';

/** Beijing has no city-specific station corrections yet. */
export const transformStations: TransformStations = (stations) => stations;

export interface BeijingNormalizeOptions {
  /** Repository root containing `data/cn-beijing`. */
  root?: string;
  /** Skip live searchstartend harvest (offline / partial rebuilds). */
  skipPlannerTimes?: boolean;
}

/**
 * Clear official `@ut` values that are physically impossible vs trusted
 * station coordinates (e.g. Line 88 大兴机场线 publishes 110s on ~12 km and
 * ~25 km hops). `applyHarvestedSegmentTimes` only overwrites non-`source`
 * rows, so these must be demoted first for the planner harvest to repair them.
 */
function demoteImplausibleSourceTimes(
  segments: SegmentEncoded[],
  stations: StationEncoded[],
  lines: LineEncoded[]
): { segments: SegmentEncoded[]; demoted: number } {
  const byId = new Map(stations.map((s) => [s.id, s] as const));
  const modeByLine = new Map(lines.map((l) => [l.id, l.mode] as const));
  let demoted = 0;
  const out = segments.map((s) => {
    const t = s.travel_time_seconds;
    if (s.travel_time_source !== 'source' || !(t && t > 0)) return s;
    const a = byId.get(s.from_station_id)?.location;
    const b = byId.get(s.to_station_id)?.location;
    if (!a || !b) return s;
    const km = haversineKm(a, b);
    if (!(km > 0.5)) return s;
    const mode = modeByLine.get(s.line_id);
    const maxV = MODE_MAX_SPEED_KMH[mode ?? 'other'] ?? 120;
    const speed = km / (t / 3600);
    if (speed <= maxV) return s;
    demoted++;
    return {
      ...s,
      travel_time_seconds: undefined,
      travel_time_source: undefined,
      extras: {
        ...(s.extras ?? {}),
        demoted_source_time_seconds: t,
        demote_reason: 'implausible_vs_coords'
      }
    };
  });
  return { segments: out, demoted };
}

export async function runBeijingNormalize(opts: BeijingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-beijing');

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
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      // Official beijing.xml publishes airport-express run times that are
      // impossible vs AMap coords (Line 88 草桥–大兴新城 ~12 km / 110s).
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
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
    { network: canonical.network.id, city: '北京' }
  );

  const officialFromCanonical = canonical.transfers
    .filter((t) => t.source_id && !String(t.source_id).startsWith('auto-xfer/v1'))
    .map((t) => ({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id,
      walk_time_seconds: t.walk_time_seconds,
      is_out_of_station: t.is_out_of_station,
      source_id: t.source_id
    }));

  let segments = canonical.segments;
  let transfers = deriveTransfers(stations, canonical.stops, officialFromCanonical, {
    patterns: canonical.patterns,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  const demoted = demoteImplausibleSourceTimes(segments, stations, lines);
  segments = demoted.segments;
  if (demoted.demoted > 0) {
    console.log(`  demoted implausible official segment times: ${demoted.demoted}`);
  }

  if (!opts.skipPlannerTimes) {
    console.log('  harvest searchstartend segment/transfer times');
    const nameByStationId = new Map(canonical.stations.map((s) => [s.id, s.name]));
    const nameByStopId = new Map(
      canonical.stops.map((s) => [s.id, nameByStationId.get(s.station_id)])
    );
    const harvested = await collectBeijingPlannerTimes({
      patterns: canonical.patterns,
      stops: canonical.stops,
      transfers: transfers,
      stopName: (stopId) => nameByStopId.get(stopId)
    });
    const seg = applyHarvestedSegmentTimes(segments, harvested.segments);
    const xfer = applyHarvestedTransferTimes(transfers, harvested.transfers);
    segments = seg.segments;
    transfers = xfer.transfers;
    console.log(`  applied planner times: ${seg.applied} segments, ${xfer.applied} transfers`);
  }

  // Any remaining gap falls back to last-train / default without clobbering
  // planner/source values already applied.
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

  await writeCanonical(outDir, 'cn-beijing', {
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
