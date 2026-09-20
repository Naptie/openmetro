/**
 * Leave-one-out segment-speed validation for station coordinates.
 *
 * For each station, drop its own segments and average the implied speeds of
 * the remaining adjacent pairs on the same line(s). A candidate coordinate is
 * rejected when its neighbour segments are implausible against that baseline —
 * stations essentially co-located with a non-trivial runtime (too close), or
 * implied speeds far above the baseline (too far).
 *
 * Thresholds are calibrated on cn-beijing/cn-guangzhou/cn-shanghai canonical data:
 * trusted-ratio p5≈0.56 p50≈0.98 p95≈1.51 p99≈2.91; the Guangqing 神山/江高
 * collision sits at ratio≈0.001 with d≈5 m / t=360 s.
 */
import { haversineKm } from './consistency.js';

export interface SegmentAdjacency {
  from_station_id: string;
  to_station_id: string;
  line_id?: string;
  travel_time_seconds?: number;
  travel_time_source?: string;
}

export interface LocatableLike {
  id: string;
  name?: string;
  names?: { zh?: string };
  location?: { lon: number; lat: number; crs: string };
  extras?: Record<string, unknown>;
}

export interface SpeedViolation {
  kind: 'too_close' | 'too_far';
  line_id?: string;
  other_station_id: string;
  other_station_name?: string;
  distance_km: number;
  travel_time_seconds: number;
  speed_kmh: number;
  baseline_kmh: number;
  ratio: number;
  travel_time_source?: string;
  detail: string;
}

export interface StationSpeedReport {
  station_id: string;
  station_name?: string;
  ok: boolean;
  /** Leave-one-out mean speed on the station's lines (km/h), if judgeable. */
  baseline_kmh?: number;
  baseline_segments: number;
  violations: SpeedViolation[];
  /** True when there are too few timed same-line peers to judge. */
  skipped?: 'no_segments' | 'insufficient_baseline' | 'no_neighbour_coords';
}

export type LineModeRef = { id: string; mode?: string };

/** Upper bound of ordinary operating speed by mode (km/h). */
export const MODE_MAX_SPEED_KMH: Record<string, number> = {
  metro: 120,
  light_rail: 80,
  monorail: 80,
  tram: 50,
  airport_express: 160,
  suburban_rail: 160,
  other: 120
};

export function modeMaxSpeedKmh(mode: string | undefined): number {
  return MODE_MAX_SPEED_KMH[mode ?? 'other'] ?? MODE_MAX_SPEED_KMH.other;
}

/** Calibrated speed-validation thresholds. */
export const SPEED_VALIDATE = {
  /** LOO ratio below this, on a short segment, means the candidate is too close. */
  ratioMin: 0.2,
  /** Absolute too-close: co-located points that still carry a real runtime. */
  tooCloseDistM: 120,
  tooCloseTimeS: 120,
  /** Only apply ratioMin when the segment is compact (avoids timetable noise). */
  ratioTooCloseMaxDistKm: 0.5,
  /** LOO ratio above this means the candidate is too far. */
  ratioMax: 4.0,
  /** Minimum non-self same-line timed pairs before LOO is trusted. */
  minBaselineSegments: 2,
  /** Ignore a segment if its time is impossible even at factor× mode max speed. */
  timePlausibilityFactor: 2.0
} as const;

/** Travel-time sources that never carry real schedule information. */
export const UNTRUSTED_TIME_SOURCES: ReadonlySet<string> = new Set([
  'default',
  'estimated',
  'none'
]);

/** Coordinate provenance we trust even when an official runtime looks impossible. */
const TRUSTED_COORD_SOURCES: ReadonlySet<string> = new Set([
  'subway',
  'official',
  'known',
  'source',
  'operator',
  'amap',
  'osm',
  'overpass'
]);

function stationNameOf(st: LocatableLike): string | undefined {
  return st.names?.zh ?? st.name;
}

function coordSourceOf(st: LocatableLike | undefined): string | undefined {
  const src = st?.extras?.location_source;
  return typeof src === 'string' ? src : undefined;
}

function isTrustedCoordSource(src: string | undefined): boolean {
  if (!src) return false;
  return TRUSTED_COORD_SOURCES.has(src);
}

function isTrustedTime(source: string | undefined, seconds: number | undefined): boolean {
  if (seconds == null || !(seconds > 0)) return false;
  if (source && UNTRUSTED_TIME_SOURCES.has(source)) return false;
  return true;
}

/**
 * Mean implied speed (km/h) of adjacent pairs on `lineIds` that do not involve
 * `stationId`. Returns undefined when fewer than `minSegments` pairs qualify.
 */
export function meanLeaveOneOutSpeedKmh(
  segments: SegmentAdjacency[],
  stationId: string,
  lineIds: string[],
  locations: Map<string, { lon: number; lat: number }>,
  minSegments = SPEED_VALIDATE.minBaselineSegments
): { mean: number; n: number; speeds: number[] } | undefined {
  const lineSet = new Set(lineIds);
  const speeds: number[] = [];
  for (const seg of segments) {
    if (seg.line_id && !lineSet.has(seg.line_id)) continue;
    if (!seg.line_id && lineIds.length > 0) {
      // Segment without line id: still usable if both endpoints are on these lines.
    }
    if (stationId === seg.from_station_id || stationId === seg.to_station_id) continue;
    if (!isTrustedTime(seg.travel_time_source, seg.travel_time_seconds)) continue;
    const a = locations.get(seg.from_station_id);
    const b = locations.get(seg.to_station_id);
    if (!a || !b) continue;
    const distKm = haversineKm(a, b);
    if (!(distKm >= 0)) continue;
    const hours = (seg.travel_time_seconds as number) / 3600;
    if (!(hours > 0)) continue;
    speeds.push(distKm / hours);
  }
  if (speeds.length < minSegments) return undefined;
  const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  return { mean, n: speeds.length, speeds };
}

function allLocations(stations: LocatableLike[]): Map<string, { lon: number; lat: number }> {
  const map = new Map<string, { lon: number; lat: number }>();
  for (const st of stations) {
    const loc = st.location;
    if (loc) map.set(st.id, { lon: loc.lon, lat: loc.lat });
  }
  return map;
}

function linesOfStation(
  stationId: string,
  segments: SegmentAdjacency[]
): { lineIds: string[]; hasSegments: boolean } {
  const lineIds = new Set<string>();
  let hasSegments = false;
  for (const seg of segments) {
    if (seg.from_station_id !== stationId && seg.to_station_id !== stationId) continue;
    hasSegments = true;
    if (seg.line_id) lineIds.add(seg.line_id);
  }
  return { lineIds: [...lineIds], hasSegments };
}

function modeOfLine(
  lines: LineModeRef[] | undefined,
  lineId: string | undefined
): string | undefined {
  if (!lineId || !lines) return undefined;
  return lines.find((l) => l.id === lineId)?.mode;
}

function timeImplausible(distKm: number, timeS: number, mode: string | undefined): boolean {
  const maxV = modeMaxSpeedKmh(mode) * SPEED_VALIDATE.timePlausibilityFactor;
  if (maxV <= 0) return false;
  const minHours = distKm / maxV;
  return timeS / 3600 < minHours;
}

/**
 * Evaluate one station's current coordinates against leave-one-out segment speeds.
 * Passes when there is insufficient evidence (cannot prove the coords wrong).
 */
export function evaluateStationSpeed(
  stations: LocatableLike[],
  segments: SegmentAdjacency[],
  stationId: string,
  opts: { lines?: LineModeRef[]; locations?: Map<string, { lon: number; lat: number }> } = {}
): StationSpeedReport {
  const st = stations.find((s) => s.id === stationId);
  const name = st ? stationNameOf(st) : undefined;
  const locations = opts.locations ?? allLocations(stations);
  const report: StationSpeedReport = {
    station_id: stationId,
    station_name: name,
    ok: true,
    baseline_segments: 0,
    violations: []
  };

  const loc = locations.get(stationId);
  if (!loc) {
    report.ok = true;
    report.skipped = 'no_neighbour_coords';
    return report;
  }

  const { lineIds, hasSegments } = linesOfStation(stationId, segments);
  if (!hasSegments) {
    report.skipped = 'no_segments';
    return report;
  }

  const loo = meanLeaveOneOutSpeedKmh(segments, stationId, lineIds, locations);
  if (!loo) {
    report.skipped = 'insufficient_baseline';
    return report;
  }
  report.baseline_kmh = loo.mean;
  report.baseline_segments = loo.n;

  const violations: SpeedViolation[] = [];
  for (const seg of segments) {
    const isFrom = seg.from_station_id === stationId;
    const isTo = seg.to_station_id === stationId;
    if (!isFrom && !isTo) continue;
    if (seg.line_id && lineIds.length > 0 && !lineIds.includes(seg.line_id)) continue;
    if (!isTrustedTime(seg.travel_time_source, seg.travel_time_seconds)) continue;

    const otherId = isFrom ? seg.to_station_id : seg.from_station_id;
    const otherLoc = locations.get(otherId);
    if (!otherLoc) continue;

    const distKm = haversineKm(otherLoc, loc);
    const timeS = seg.travel_time_seconds as number;
    const mode = modeOfLine(opts.lines, seg.line_id);
    if (timeImplausible(distKm, timeS, mode)) {
      // Impossibility can mean either a placeholder coordinate or a bad
      // official runtime (e.g. Beijing Line 88 publishes 110s on ~12–25 km
      // airport segments). Only treat it as a coordinate failure when the
      // endpoint provenance is untrusted; AMap/official/known points keep
      // their location and the source time is simply suspect.
      const thisSt = stations.find((s) => s.id === stationId);
      const otherSt = stations.find((s) => s.id === otherId);
      const thisTrusted = isTrustedCoordSource(coordSourceOf(thisSt));
      const otherTrusted = isTrustedCoordSource(coordSourceOf(otherSt));
      if (thisTrusted && (otherTrusted || !coordSourceOf(otherSt))) {
        continue;
      }
      const maxV = modeMaxSpeedKmh(mode) * SPEED_VALIDATE.timePlausibilityFactor;
      violations.push({
        kind: 'too_far',
        line_id: seg.line_id,
        other_station_id: otherId,
        other_station_name: otherSt ? stationNameOf(otherSt) : undefined,
        distance_km: distKm,
        travel_time_seconds: timeS,
        speed_kmh: distKm / (timeS / 3600),
        baseline_kmh: loo.mean,
        ratio: distKm / ((loo.mean * timeS) / 3600),
        travel_time_source: seg.travel_time_source,
        detail: `implausible distance ${distKm.toFixed(2)} km for travel_time=${timeS}s (max ${maxV} km/h)`
      });
      continue;
    }

    const speedKmh = distKm / (timeS / 3600);
    const ratio = loo.mean > 0 ? speedKmh / loo.mean : Number.POSITIVE_INFINITY;
    const otherSt = stations.find((s) => s.id === otherId);
    const base = {
      line_id: seg.line_id,
      other_station_id: otherId,
      other_station_name: otherSt ? stationNameOf(otherSt) : undefined,
      distance_km: distKm,
      travel_time_seconds: timeS,
      speed_kmh: speedKmh,
      baseline_kmh: loo.mean,
      ratio,
      travel_time_source: seg.travel_time_source
    };

    const distM = distKm * 1000;
    const tooCloseAbs =
      distM < SPEED_VALIDATE.tooCloseDistM && timeS >= SPEED_VALIDATE.tooCloseTimeS;
    const tooCloseRatio =
      ratio < SPEED_VALIDATE.ratioMin && distKm <= SPEED_VALIDATE.ratioTooCloseMaxDistKm;
    const tooFar = ratio > SPEED_VALIDATE.ratioMax;

    if (tooCloseAbs || tooCloseRatio) {
      violations.push({
        ...base,
        kind: 'too_close',
        detail: tooCloseAbs
          ? `${distM.toFixed(1)} m apart but travel_time=${timeS}s`
          : `speed ratio ${ratio.toFixed(3)} < ${SPEED_VALIDATE.ratioMin} on ${distKm.toFixed(3)} km`
      });
    } else if (tooFar) {
      violations.push({
        ...base,
        kind: 'too_far',
        detail: `speed ratio ${ratio.toFixed(3)} > ${SPEED_VALIDATE.ratioMax} (v=${speedKmh.toFixed(1)} km/h vs baseline ${loo.mean.toFixed(1)})`
      });
    }
  }

  report.violations = violations;
  report.ok = violations.length === 0;
  return report;
}

/** Evaluate every station that appears in `segments`. */
export function evaluateNetworkSpeeds(
  stations: LocatableLike[],
  segments: SegmentAdjacency[],
  opts: { lines?: LineModeRef[] } = {}
): StationSpeedReport[] {
  const ids = new Set<string>();
  for (const seg of segments) {
    ids.add(seg.from_station_id);
    ids.add(seg.to_station_id);
  }
  const locations = allLocations(stations);
  const out: StationSpeedReport[] = [];
  for (const id of ids) {
    out.push(
      evaluateStationSpeed(stations, segments, id, {
        lines: opts.lines,
        locations
      })
    );
  }
  return out;
}

export function formatSpeedReport(report: StationSpeedReport): string {
  const label = report.station_name ?? report.station_id;
  if (report.ok) {
    return `${label}: ok (baseline=${report.baseline_kmh?.toFixed(1) ?? 'n/a'} km/h, n=${report.baseline_segments}${report.skipped ? `, skipped=${report.skipped}` : ''})`;
  }
  const parts = report.violations.map(
    (v) => `${v.kind} via ${v.other_station_name ?? v.other_station_id}: ${v.detail}`
  );
  return `${label}: FAIL baseline=${report.baseline_kmh?.toFixed(1) ?? 'n/a'} — ${parts.join('; ')}`;
}
