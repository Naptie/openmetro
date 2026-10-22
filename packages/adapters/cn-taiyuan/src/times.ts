/**
 * Official run metrics for Taiyuan Metro, harvested from the operator's own
 * route planner (`busExt` — the backend behind the "路线查询" page on
 * `www.tymetro.ltd`).
 *
 * Two harvests:
 *
 * 1. **Segment metrics** — one query per adjacent stop pair. The planner
 *    returns, for the ride leg:
 *      - `busDriveTime` — pure in-vehicle run time (the headway wait is
 *        reported separately as `busWaitTime`; `drivertime` is the sum of the
 *        two and must NOT be used as a segment run time),
 *      - `driverlength` — ride length in metres,
 *      - `drivercoord`  — the ride geometry in GCJ-02.
 *    These are official planner values, so the segments carry
 *    `travel_time_source: 'source'`.
 *
 * 2. **In-station transfer walks** — the planner marks the leg that starts
 *    after an interchange with `transfertype: "1"` and describes the walk
 *    through the station (`footlength`, `walk.infolist[].distance` and the
 *    walk polyline).
 *
 *    The planner's `foottime` is **not** used as the walk time: it varies
 *    with the arrival and departure direction at 大南门 (84 s – 274 s) because
 *    it folds in the wait for the departing train and the platform access
 *    path. The official planner publishes no clean walk time, so the walking
 *    time itself is left to the core `gapfill` layer (Baidu planner harvest,
 *    which measures the walk through the station) and the official planner
 *    detail is recorded as provenance only.
 */
import type { Geometry, PatternEncoded, SegmentEncoded, StopEncoded } from '@openmetro/core';

import {
  fetchPlannerRoute,
  type PlannerResponse,
  type PlannerSegment,
  type PlannerStation,
  parseCoordPairs
} from './fetch.js';

export const TY_SEGMENT_SOURCE = 'tymetro-planner';
export const TY_TRANSFER_SOURCE = 'tymetro-planner-transfer';

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface TaiyuanSegmentMetric {
  from_stop_id: string;
  to_stop_id: string;
  travel_time_seconds?: number;
  distance_km?: number;
  /** Ride geometry in GCJ-02. */
  geometry?: Geometry;
  extras?: Record<string, unknown>;
}

export interface TaiyuanTransferWalk {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  /** Station-to-station walk length published by the operator's planner. */
  walk_length_m?: number;
  /** Length of the walk polyline itself. */
  walk_path_length_m?: number;
  /** Planner-reported foot time for the observed OD (includes waiting). */
  planner_foot_time_s?: number;
  /** Walk polyline in GCJ-02. */
  walk_geometry?: Geometry;
}

function num(v: string | number | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The ride leg of a planner response (the first one — Taiyuan is a 1–2 line network). */
function rideSegment(res: PlannerResponse | undefined): PlannerSegment | undefined {
  const segs = res?.buslist?.[0]?.segmentlist ?? [];
  return segs.find((s) => s.busDriveTime != null && Number(s.busDriveTime) > 0) ?? segs[0];
}

/** The leg that starts after an in-station interchange. */
function transferSegment(res: PlannerResponse | undefined): PlannerSegment | undefined {
  const segs = res?.buslist?.[0]?.segmentlist ?? [];
  return segs.find((s) => s.transfertype === '1');
}

/**
 * Harvest the official run time / distance / geometry of every adjacent stop
 * pair (one planner query per undirected edge).
 */
export async function collectTaiyuanSegmentMetrics(opts: {
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  /** Planner-side station reference per stop id. */
  stationOf: (stopId: string) => PlannerStation | undefined;
  concurrency?: number;
  delayMs?: number;
}): Promise<{ segments: TaiyuanSegmentMetric[]; fetched: number; failed: number }> {
  const pairs = new Map<string, { from: string; to: string }>();
  for (const p of opts.patterns) {
    const ids = p.stop_ids;
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i]!;
      const b = ids[i + 1]!;
      if (!a || !b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      pairs.set(key, { from: a, to: b });
    }
  }
  const list = [...pairs.values()];
  console.log(`  harvest ${list.length} adjacent pairs via the official route planner`);

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const delayMs = opts.delayMs ?? 80;
  let next = 0;
  let fetched = 0;
  let failed = 0;
  const out: TaiyuanSegmentMetric[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      const pair = list[i]!;
      const from = opts.stationOf(pair.from);
      const to = opts.stationOf(pair.to);
      if (!from || !to) {
        failed++;
        continue;
      }
      const res = await fetchPlannerRoute(from, to);
      const seg = rideSegment(res);
      if (!seg) {
        failed++;
      } else {
        const run = num(seg.busDriveTime);
        const meters = num(seg.driverlength);
        const points = parseCoordPairs(seg.drivercoord);
        const metric: TaiyuanSegmentMetric = {
          from_stop_id: pair.from,
          to_stop_id: pair.to,
          travel_time_seconds: run != null && run > 0 ? Math.round(run) : undefined,
          distance_km: meters != null && meters > 0 ? Math.round(meters) / 1000 : undefined,
          geometry:
            points.length >= 2
              ? { crs: 'gcj02', points: points.map((p) => ({ ...p, crs: 'gcj02' as const })) }
              : undefined,
          extras: {
            planner_line: seg.bus_key_name,
            planner_ride: seg.busname,
            run_time_s: num(seg.busDriveTime),
            headway_wait_s: num(seg.busWaitTime),
            total_leg_time_s: num(seg.drivertime),
            headway: seg.interval_desc || undefined,
            first_train: seg.starttime || undefined,
            last_train: seg.endtime || undefined,
            line_color: seg.color ? `#${seg.color.toLowerCase()}` : undefined
          }
        };
        if (metric.travel_time_seconds) fetched++;
        out.push(metric);
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length || 1) }, () => worker())
  );
  return { segments: out, fetched, failed };
}

/**
 * Merge the official planner metrics into the canonical segments.
 *
 * The planner is the operator's own route planner, so its hop time counts as
 * `source` precision (same policy as the Zhengzhou/Suzhou adapters).
 */
export function applyTaiyuanSegmentMetrics(
  segments: SegmentEncoded[],
  metrics: TaiyuanSegmentMetric[]
): { segments: SegmentEncoded[]; applied: number } {
  const byPair = new Map<string, TaiyuanSegmentMetric>();
  for (const m of metrics) {
    if (!m.travel_time_seconds || m.travel_time_seconds <= 0) continue;
    const key = pairKey(m.from_stop_id, m.to_stop_id);
    if (!byPair.has(key)) byPair.set(key, m);
  }
  let applied = 0;
  const out = segments.map((s) => {
    const hit = byPair.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!hit) return s;
    if (
      s.travel_time_source === 'source' &&
      s.travel_time_seconds === hit.travel_time_seconds &&
      s.distance_km === hit.distance_km
    ) {
      return s;
    }
    applied++;
    return {
      ...s,
      travel_time_seconds: hit.travel_time_seconds ?? s.travel_time_seconds,
      travel_time_source: 'source' as const,
      travel_time_derived_from: undefined,
      distance_km: hit.distance_km ?? s.distance_km,
      geometry: hit.geometry ?? s.geometry,
      source_id: TY_SEGMENT_SOURCE,
      extras: {
        ...(s.extras ?? {}),
        ...(hit.extras ?? {}),
        planner_time_source: TY_SEGMENT_SOURCE,
        distance_source: hit.distance_km != null ? 'source' : undefined
      }
    };
  });
  return { segments: out, applied };
}

/**
 * Harvest the operator planner's description of the in-station interchange
 * walk. Provenance only — the walking time itself is measured by the core
 * `gapfill` layer.
 */
export async function collectTaiyuanTransferWalks(opts: {
  /** Transfer station id → the lines it serves. */
  hubs: { station_id: string; lineIds: string[] }[];
  /** A planner station reference near the hub on each line, away from the hub. */
  probeOf: (stationId: string, lineId: string) => PlannerStation | undefined;
  concurrency?: number;
  delayMs?: number;
}): Promise<TaiyuanTransferWalk[]> {
  const out: TaiyuanTransferWalk[] = [];
  const delayMs = opts.delayMs ?? 120;

  for (const hub of opts.hubs) {
    for (const fromLine of hub.lineIds) {
      for (const toLine of hub.lineIds) {
        if (fromLine === toLine) continue;
        const from = opts.probeOf(hub.station_id, fromLine);
        const to = opts.probeOf(hub.station_id, toLine);
        if (!from || !to) continue;
        const res = await fetchPlannerRoute(from, to);
        const seg = transferSegment(res);
        if (!seg) continue;
        const info = seg.walk?.infolist?.[0];
        const points = parseCoordPairs(info?.coord);
        out.push({
          station_id: hub.station_id,
          from_line_id: fromLine,
          to_line_id: toLine,
          walk_length_m: num(seg.footlength) ?? undefined,
          walk_path_length_m: num(info?.distance) ?? undefined,
          planner_foot_time_s: num(seg.foottime) ?? undefined,
          walk_geometry:
            points.length >= 2
              ? { crs: 'gcj02', points: points.map((p) => ({ ...p, crs: 'gcj02' as const })) }
              : undefined
        });
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  return out;
}
