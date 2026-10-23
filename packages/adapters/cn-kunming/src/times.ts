/**
 * Planner harvest for Kunming Rail Transit.
 *
 * The AMap metro planner (`busExt`) answers one OD query with everything the
 * network publishes for that leg:
 *
 * - `busDriveTime` — the pure in-vehicle run time (`drivertime` additionally
 *   contains the headway wait and must not be used as a run time);
 * - `driverlength` — the ride length in metres;
 * - `drivercoord` — the ride geometry (GCJ-02);
 * - `expense` — the OD fare;
 * - `stationStartTime` / `stationEndTime` — the first/last train at the
 *   boarding station for the service the planner picked;
 * - `busname` — the service pattern (交路) the train belongs to;
 * - `interval_desc` — the scheduled headway.
 *
 * ## What is queried
 *
 * For every service pattern (alignment) of every line:
 *
 * 1. one **whole-line** query (origin → terminal) for the ride geometry;
 * 2. one query per **adjacent pair** for the segment run time and length;
 * 3. two queries per station (toward the pattern's tail, toward its head)
 *    for the first/last windows.
 *
 * Queries are cached per ordered station pair, so the adjacent-pair query and
 * the toward-tail query of the same hop cost one request.
 *
 * ## Why the planner's answer is taken at face value
 *
 * A service pattern label names both of its ends (`地铁1号线(A--B)`), and the
 * planner picks the service that reaches the requested destination. On Line 1
 * that means a trunk station asked towards 昆明南火车站 answers with the
 * branch service while the same station asked towards 大学城南 answers with
 * the main-line service — both are real trains serving that station, so both
 * are recorded, each against the alignment it belongs to.
 */
import type { Geometry } from '@openmetro/core';

import {
  type AmapStation,
  fetchPlannerRoute,
  type PlannerResponse,
  type PlannerSegment,
  type PlannerStation,
  parsePlannerCoordPairs,
  parseServicePattern
} from './fetch.js';

/** Official run metrics for one adjacent pair. */
export interface HarvestedSegmentMetric {
  from_stop_id: string;
  to_stop_id: string;
  /** In-vehicle run time in seconds. */
  travel_time_seconds?: number;
  /** Ride length in kilometres. */
  distance_km?: number;
  /** Ride geometry in GCJ-02. */
  geometry?: Geometry;
  extras?: Record<string, unknown>;
}

/** The first/last window of one service at one station. */
export interface HarvestedService {
  /** AMap name of the station the window belongs to. */
  amapName: string;
  /** Service pattern label, e.g. `地铁1号线(A--B)`. */
  busname?: string;
  /** Origin station name of the service. */
  origin?: string;
  /** Destination station name of the service. */
  destination?: string;
  first?: string;
  last?: string;
  /** Headway description, e.g. `首站发车约10分钟/趟`. */
  headway?: string;
  /** Alignment the query ran along — the fallback attribution. */
  queryRole: 'primary' | 'branch';
  /** Direction the query ran in — 'down' heads for the alignment's terminal. */
  queryDirection: 'down' | 'up';
}

/** Everything harvested for one line. */
export interface LinePatternHarvest {
  /** Line short name (`1` … `6`). */
  short: string;
  segments: HarvestedSegmentMetric[];
  services: HarvestedService[];
  /** Cells the planner answered but the adapter could not attribute. */
  rejected: string[];
}

/** One service pattern to harvest. */
export interface HarvestAlignment {
  role: 'primary' | 'branch';
  /** Ordered AMap station names of the alignment. */
  amapNames: string[];
  /** Planner station references, in the same order. */
  stations: PlannerStation[];
  /** Stop ids, in the same order. */
  stopIds: string[];
}

export interface HarvestLine {
  short: string;
  /** Vehicle name the planner uses for this line, e.g. `地铁4号线`. */
  plannerName: string;
  alignments: HarvestAlignment[];
}

/** Build a planner reference from an AMap station record. */
export function plannerStationOf(st: AmapStation): PlannerStation | undefined {
  const [lon, lat] = String(st.sl ?? '')
    .split(',')
    .map((v) => Number(v));
  const poiid = String(st.poiid ?? '').trim();
  if (!poiid || !Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { name: String(st.n ?? ''), lon, lat, poiid };
}

interface CacheEntry {
  response: PlannerResponse | undefined;
}

function rideSegment(response: PlannerResponse | undefined): PlannerSegment | undefined {
  const segs = response?.buslist?.[0]?.segmentlist ?? [];
  return segs.find((s) => s.busDriveTime && Number(s.busDriveTime) > 0) ?? segs[0];
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Fold a station name so the planner's and AMap's spellings compare equal. */
function foldName(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[（(][^)）]*[)）]/g, '')
    .split('·')[0]!
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Split a whole-line polyline at the station coordinates.
 *
 * The planner returns the geometry of a whole ride as one polyline; each
 * segment then owns the slice between its two stations. The cut is the
 * polyline vertex closest to each station, which is exact for a line whose
 * stations all lie on the alignment.
 */
export function splitPolylineByStations(
  points: { lon: number; lat: number }[],
  stations: { lon: number; lat: number }[]
): { lon: number; lat: number }[][] | undefined {
  if (points.length < 2 || stations.length < 2) return undefined;
  const cuts: number[] = [];
  let searchFrom = 0;
  for (const station of stations) {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = searchFrom; i < points.length; i++) {
      const p = points[i]!;
      const dx = p.lon - station.lon;
      const dy = p.lat - station.lat;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0) return undefined;
    cuts.push(best);
    searchFrom = best;
  }
  const out: { lon: number; lat: number }[][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const slice = points.slice(cuts[i]!, cuts[i + 1]! + 1);
    if (slice.length < 2) return undefined;
    out.push(slice);
  }
  return out.length === stations.length - 1 ? out : undefined;
}

export interface HarvestOptions {
  concurrency?: number;
  /** Pause between planner requests, in milliseconds. */
  delayMs?: number;
  retries?: number;
}

/**
 * Harvest every line of the network.
 *
 * `onProgress` is called with a short status line per line so the sync log
 * shows what is happening.
 */
export async function harvestKunmingPlanner(
  lines: HarvestLine[],
  opts: HarvestOptions & { onProgress?: (msg: string) => void } = {}
): Promise<LinePatternHarvest[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const delayMs = opts.delayMs ?? 60;
  const retries = opts.retries ?? 3;
  const log = opts.onProgress ?? ((msg: string) => console.log(msg));

  const out: LinePatternHarvest[] = [];

  for (const line of lines) {
    const segments: HarvestedSegmentMetric[] = [];
    const services: HarvestedService[] = [];
    const rejected: string[] = [];
    const cache = new Map<string, CacheEntry>();

    const query = async (
      from: PlannerStation,
      to: PlannerStation
    ): Promise<PlannerResponse | undefined> => {
      const key = `${from.poiid}->${to.poiid}`;
      const hit = cache.get(key);
      if (hit) return hit.response;
      const response = await fetchPlannerRoute(from, to, retries);
      cache.set(key, { response });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return response;
    };

    /** The planner's service label for a response, if any. */
    const serviceLabelOf = (response: PlannerResponse | undefined): string | undefined =>
      response?.buslist?.[0]?.segmentlist?.[0]?.busname;

    for (const alignment of line.alignments) {
      const { amapNames, stations, stopIds } = alignment;
      const n = stations.length;
      if (n < 2) continue;

      // 1. Whole-line geometry.
      const whole = await query(stations[0]!, stations[n - 1]!);
      const wholeSeg = rideSegment(whole);
      const wholePoints = parsePlannerCoordPairs(wholeSeg?.drivercoord);
      const slices =
        wholePoints.length >= 2
          ? splitPolylineByStations(
              wholePoints,
              stations.map((s) => ({ lon: s.lon, lat: s.lat }))
            )
          : undefined;

      // 2. Segment metrics + 3. service windows, interleaved so the cached
      //    adjacent-pair query also serves as the toward-tail/head window.
      type Job =
        | { kind: 'segment'; i: number }
        | { kind: 'window'; i: number; toward: 'tail' | 'head' };
      const jobs: Job[] = [];
      for (let i = 0; i < n - 1; i++) jobs.push({ kind: 'segment', i });
      for (let i = 0; i < n - 1; i++) jobs.push({ kind: 'window', i, toward: 'tail' });
      for (let i = 1; i < n; i++) jobs.push({ kind: 'window', i, toward: 'head' });

      let next = 0;
      let mismatches = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = next++;
          if (idx >= jobs.length) return;
          const job = jobs[idx]!;
          const from = stations[job.i]!;
          const to =
            job.kind === 'segment'
              ? stations[job.i + 1]!
              : job.toward === 'tail'
                ? stations[n - 1]!
                : stations[0]!;
          if (from.poiid === to.poiid) continue;

          let response = await query(from, to);
          let segment = rideSegment(response);
          /**
           * A hop is accepted on the strength of the *physical ride*, not the
           * vehicle label: at 环城南路 — where Lines 1 and 2 are through
           * connected — the planner sometimes answers with the neighbouring
           * line's service, and the run time and length of the ride are the
           * same either way. The label is kept as provenance.
           */
          const directRide = (seg: PlannerSegment | undefined, endName: string) =>
            !!seg && !seg.passdepotname && foldName(seg.endname) === foldName(endName);

          if (!directRide(segment, to.name) && job.kind === 'segment') {
            const reverse = await query(to, from);
            const reverseSegment = rideSegment(reverse);
            if (directRide(reverseSegment, from.name)) {
              response = reverse;
              segment = reverseSegment;
            }
          }

          if (!segment) {
            if (job.kind === 'segment') {
              mismatches++;
              rejected.push(`segment ${from.name}->${to.name}: no usable ride leg`);
            }
            continue;
          }

          if (job.kind === 'segment') {
            if (!directRide(segment, to.name)) {
              mismatches++;
              rejected.push(
                `segment ${from.name}->${to.name}: planner answered ${serviceLabelOf(response) ?? 'nothing'}` +
                  (segment.passdepotname ? ` via ${segment.passdepotname}` : '')
              );
              continue;
            }
            const run = num(segment.busDriveTime);
            const meters = num(segment.driverlength);
            const slice = slices?.[job.i];
            const plannerLine = parseServicePattern(segment.busname)?.line;
            segments.push({
              from_stop_id: stopIds[job.i]!,
              to_stop_id: stopIds[job.i + 1]!,
              travel_time_seconds: run != null && run > 0 ? Math.round(run) : undefined,
              distance_km: meters != null && meters > 0 ? Math.round(meters) / 1000 : undefined,
              geometry:
                slice && slice.length >= 2
                  ? {
                      crs: 'gcj02',
                      points: slice.map((p) => ({ ...p, crs: 'gcj02' as const }))
                    }
                  : undefined,
              extras: {
                planner_service: segment.busname,
                headway: segment.interval_desc,
                line_short_name: line.short,
                pattern_role: alignment.role,
                ...(plannerLine && plannerLine !== line.plannerName
                  ? { planner_line_mismatch: plannerLine }
                  : {})
              }
            });
            continue;
          }

          // Service window.
          const label = segment.busname;
          if (!label) {
            rejected.push(`window ${from.name}->${to.name}: planner gave no service label`);
            continue;
          }
          const parsed = parseServicePattern(label);
          if (!parsed) {
            rejected.push(`window ${from.name}->${to.name}: unparsable label ${label}`);
            continue;
          }
          services.push({
            amapName: amapNames[job.i]!,
            busname: label,
            origin: parsed.origin,
            destination: parsed.destination,
            first: segment.stationStartTime,
            last: segment.stationEndTime,
            headway: segment.interval_desc,
            queryRole: alignment.role,
            queryDirection: job.toward === 'tail' ? 'down' : 'up'
          });
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
      log(
        `    ${line.short}/${alignment.role}: ${segments.length} segments, ${services.length} windows` +
          (mismatches ? `, ${mismatches} planner mismatches` : '')
      );
      if (rejected.length) {
        log(`      ${rejected.length} unattributed cells:`);
        for (const reason of rejected.slice(0, 12)) log(`        ${reason}`);
      }
    }

    out.push({ short: line.short, segments, services, rejected });
  }

  return out;
}
