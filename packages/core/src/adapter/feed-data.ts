import { writeCanonical } from '../data/write.js';
import { assertPatternGeometryReferences } from '../graph/geometry.js';
import { deriveTransfers } from '../graph/transfers.js';
import type {
  FareMatrixEncoded,
  NetworkEncoded,
  TimetableEncoded,
  TransferEncoded
} from '../schema/index.js';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  fillMissingSegmentTimes
} from '../timetable/derive.js';
import {
  estimateTimesFromDistanceSpeed,
  fillStraightLineDistances
} from '../timetable/estimate.js';
import { normalizeTimetableTimes } from '../timetable/time.js';
import type { buildFeedTopology } from './feed.js';

export type FeedTopology = ReturnType<typeof buildFeedTopology>;

export interface FeedNetworkInput {
  network: NetworkEncoded;
  topology: FeedTopology;
  timetables: TimetableEncoded[];
  fares: FareMatrixEncoded;
  sources: FareMatrixEncoded['source'];
  transfers?: TransferEncoded[];
}

/** Shared time/distance and transfer derivation, before canonical persistence. */
export function prepareFeedNetwork(options: FeedNetworkInput) {
  const { topology: d, network } = options;
  assertPatternGeometryReferences(d.patterns, d.stops, d.lines);
  const timetables = options.timetables.map(normalizeTimetableTimes);
  let segments = applyDerivedTimes(
    d.segments,
    deriveSegmentTimes(d.patterns, d.stops, timetables, {})
  );
  segments = fillStraightLineDistances(segments, d.stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, d.patterns, d.stops, timetables);
  const transfers = deriveTransfers(d.stations, d.stops, options.transfers ?? [], {
    patterns: d.patterns,
    routing: network.routing
  });
  return {
    network: { ...network },
    lines: d.lines,
    stations: d.stations,
    stops: d.stops,
    patterns: d.patterns,
    segments,
    transfers,
    timetables,
    fares: options.fares
  };
}

/** Shared time/distance derivation and canonical writer; no city-specific fetching here. */
export async function writeFeedNetwork(
  options: FeedNetworkInput & { root: string; dataDir: string }
) {
  const data = prepareFeedNetwork(options);
  await writeCanonical(options.dataDir, data.network.id, data, options.sources);
  console.log(
    `[${data.network.id}] ${data.lines.length} lines, ${data.stations.length} stations, ${data.timetables.length} timetables`
  );
}
