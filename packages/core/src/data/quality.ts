/**
 * Per-layer data quality: precision of published values + coverage of the
 * network. Computed from canonical records at write time so it cannot drift
 * from the data.
 *
 * Precision ladder (best → worst for a single value):
 * - `official` — operator publishes this exact metric (beijing.xml `@_ut`,
 *   interchange.xml `t`, plantrip `waitTime` / `transferStationTime`, fare
 *   price, AMap/official/known coordinates, published names & first/last trains)
 * - `derived`  — inferred from another official series (last-train diffs,
 *   searchstartend cumulative-time jumps, Overpass/Photon coords; any resolved
 *   coordinate whose provenance is untagged or from a community geocoder)
 * - `default`  — network-wide constant; the source published nothing
 *   (for coordinates: station has no location at all)
 *
 * Status (for UI / quick glance):
 * - `complete`    — full coverage, official values
 * - `partial`     — some entities still fall back to the network default
 * - `derived`     — full coverage but only derived values
 * - `unavailable` — no source values at all
 */
import type { FareMatrixEncoded } from '../schema/index.js';

/** Encoded (JSON) shape of `schema/network.ts` `LayerQuality`. */
export interface LayerQualityJson {
  precision: 'official' | 'derived' | 'default';
  coverage: number;
  status: 'complete' | 'partial' | 'derived' | 'unavailable';
  counts: Record<string, number>;
}

/** Encoded (JSON) shape of `schema/network.ts` `NetworkQuality`. */
export interface NetworkQualityJson {
  topology: LayerQualityJson;
  coordinates: LayerQualityJson;
  names: LayerQualityJson;
  segment_times: LayerQualityJson;
  segment_distances: LayerQualityJson;
  transfer_times: LayerQualityJson;
  timetables: LayerQualityJson;
  schematic: LayerQualityJson;
  fares?: LayerQualityJson;
}

type Precision = LayerQualityJson['precision'];

const RANK: Record<Precision, number> = {
  official: 2,
  derived: 1,
  default: 0
};

function emptyCounts(): Record<Precision, number> {
  return { official: 0, derived: 0, default: 0 };
}

/**
 * Map a harvested planner tag to official vs derived.
 * Direct published fields (plantrip wait/transfer minutes) are official;
 * values we compute from cumulative path times (searchstartend) are derived.
 */
function plannerTagPrecision(tag: string | undefined): Precision {
  if (!tag) return 'derived';
  if (tag.includes('searchstartend')) return 'derived';
  // Direct official route-planner fields (plantrip, SZMC MinTimeJson, …).
  if (tag.includes('plantrip') || tag.includes('mintime')) return 'official';
  // Baidu gapfill planner is a full route planner — same trust tier as
  // operator plantrip / MinTimeJson (measured, not inferred).
  if (tag.includes('baidu')) return 'official';
  return 'derived';
}

function precisionFromSegmentTime(s: {
  travel_time_source?: string;
  extras?: Record<string, unknown> | undefined;
}): Precision {
  switch (s.travel_time_source) {
    case 'source':
      return 'official';
    case 'planner': {
      const tag = s.extras?.planner_time_source;
      return plannerTagPrecision(typeof tag === 'string' ? tag : undefined);
    }
    case 'last_train':
      return 'derived';
    case 'estimated':
      // Distance-based estimates calibrated from official/derived times.
      return s.extras?.time_estimate === 'distance_speed' ||
        s.extras?.time_estimate === 'distance_time_affine'
        ? 'derived'
        : 'default';
    default:
      return 'default';
  }
}

function precisionFromTransfer(t: {
  walk_time_seconds?: number | null;
  source_id?: string | undefined;
}): Precision {
  if (t.walk_time_seconds == null) return 'default';
  const src = t.source_id ?? '';
  // Operator-published interchange times and route-planner waits are official.
  if (src.includes('interchange')) return 'official';
  if (src.includes('plantrip') || src.includes('mintime')) return 'official';
  if (src.includes('searchstartend')) return 'derived';
  if (src.includes('baidu')) return 'official';
  // A documented network average is still an operator value, but not a
  // measured station-pair walk — count as derived.
  return 'derived';
}

/**
 * Coordinate provenance. Operator/AMap subways and hand-verified points are
 * official; community geocoders (Overpass / Photon / OSM) are derived.
 *
 * Presence of a `location` is the coverage signal. An unrecognized or missing
 * `location_source` tag still means a real-world point was resolved — count it
 * as `derived` rather than treating the station as coordinate-less.
 */
function precisionFromCoordSource(src: string | undefined, hasLocation: boolean): Precision {
  if (!hasLocation) return 'default';
  switch (src) {
    case 'subway':
    case 'official':
    case 'known':
    case 'source':
    case 'operator':
    case 'amap':
      return 'official';
    case 'overpass':
    case 'photon':
    case 'osm':
    case 'tencent':
    case 'geocode':
      return 'derived';
    default:
      // Location exists but provenance is untagged / alternate geocoder.
      return 'derived';
  }
}

function finalize(counts: Record<Precision, number>): LayerQualityJson {
  const total = counts.official + counts.derived + counts.default;
  const nonDefault = total - counts.default;
  const coverage = total === 0 ? 0 : Math.round((nonDefault / total) * 100) / 100;

  let precision: Precision = 'default';
  if (nonDefault > 0) {
    const present = (['official', 'derived'] as const).filter((p) => counts[p] > 0);
    precision = present.reduce((best, p) =>
      counts[p] > counts[best] || (counts[p] === counts[best] && RANK[p] > RANK[best]) ? p : best
    );
  }

  let status: LayerQualityJson['status'];
  if (coverage === 0) status = 'unavailable';
  else if (coverage === 1 && precision === 'official') status = 'complete';
  else if (coverage === 1 && precision === 'derived') status = 'derived';
  else status = 'partial';

  return { precision, coverage, status, counts };
}

function hasNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.some((x) => x !== '' && x != null);
}

export interface QualityInput {
  lines?: { id: string }[];
  stations: {
    location?: unknown;
    names?: { zh?: string; en?: string } | undefined;
    extras?: Record<string, unknown> | undefined;
  }[];
  stops?: { schematic?: unknown }[];
  segments: {
    travel_time_source?: string;
    distance_km?: number | undefined;
    extras?: Record<string, unknown> | undefined;
  }[];
  transfers: {
    walk_time_seconds?: number | null;
    source_id?: string | undefined;
  }[];
  timetables?: { first_train?: unknown; last_train?: unknown }[];
  fares?: Pick<FareMatrixEncoded, 'fares'>;
}

export function computeNetworkQuality(input: QualityInput): NetworkQualityJson {
  const topoCounts = emptyCounts();
  const hasTopology =
    (input.lines?.length ?? 0) > 0 && input.stations.length > 0 && input.segments.length > 0;
  topoCounts[hasTopology ? 'official' : 'default'] = 1;

  const coordCounts = emptyCounts();
  const nameCounts = emptyCounts();
  for (const s of input.stations) {
    const hasLocation = s.location != null;
    const src = s.extras?.location_source;
    coordCounts[precisionFromCoordSource(typeof src === 'string' ? src : undefined, hasLocation)]++;
    const zh = s.names?.zh;
    const en = s.names?.en;
    const enRomanised =
      typeof en === 'string' && /[A-Za-z]/.test(en) && !/[一-鿿]/.test(en);
    if (zh && enRomanised) nameCounts.official++;
    else if (zh || en) nameCounts.derived++;
    else nameCounts.default++;
  }

  const segTimeCounts = emptyCounts();
  const segDistCounts = emptyCounts();
  for (const s of input.segments) {
    segTimeCounts[precisionFromSegmentTime(s)]++;
    if (s.distance_km == null) segDistCounts.default++;
    else if (
      s.extras?.distance_source === 'haversine' ||
      s.extras?.distance_source === 'gcj02-coords' ||
      s.extras?.distance_source === 'derived'
    ) {
      segDistCounts.derived++;
    } else segDistCounts.official++;
  }

  const xferCounts = emptyCounts();
  for (const t of input.transfers) {
    xferCounts[precisionFromTransfer(t)]++;
  }

  const ttCounts = emptyCounts();
  for (const t of input.timetables ?? []) {
    const hasFirst = hasNonEmptyArray(t.first_train);
    const hasLast = hasNonEmptyArray(t.last_train);
    if (hasFirst && hasLast) ttCounts.official++;
    else if (hasFirst || hasLast) ttCounts.derived++;
    else ttCounts.default++;
  }
  if ((input.timetables?.length ?? 0) === 0) ttCounts.default = 1;

  const schCounts = emptyCounts();
  for (const s of input.stops ?? []) {
    schCounts[s.schematic != null ? 'official' : 'default']++;
  }
  if ((input.stops?.length ?? 0) === 0) schCounts.default = 1;

  const quality: NetworkQualityJson = {
    topology: finalize(topoCounts),
    coordinates: finalize(coordCounts),
    names: finalize(nameCounts),
    segment_times: finalize(segTimeCounts),
    segment_distances: finalize(segDistCounts),
    transfer_times: finalize(xferCounts),
    timetables: finalize(ttCounts),
    schematic: finalize(schCounts)
  };

  if (input.fares?.fares) {
    const fareCounts = emptyCounts();
    for (let i = 0; i < input.fares.fares.length; i++) {
      for (let j = 0; j < input.fares.fares[i].length; j++) {
        if (i === j) continue;
        if (input.fares.fares[i][j] != null) fareCounts.official++;
        else fareCounts.default++;
      }
    }
    const total = fareCounts.official + fareCounts.derived + fareCounts.default;
    if (total > 0) quality.fares = finalize(fareCounts);
  }

  return quality;
}
