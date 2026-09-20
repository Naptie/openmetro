/**
 * Suzhou official segment times / distances from
 * `GET /admin/stationInfo/getStationInfoById.do?id={stationCode}`.
 *
 * For each station the operator publishes directional run metrics toward the
 * next/previous stop on that line:
 *   - `downTime` / `downMove` — seconds / meters toward the down-line neighbour
 *   - `upTime`   / `upMove`   — seconds / meters toward the up-line neighbour
 *
 * These are official published values (not planner diffs), so they become
 * `travel_time_source: 'source'` on the canonical segment.
 */
import {
  adjacentStopPairs,
  type HarvestedTransferTime,
  type PatternEncoded,
  type StopEncoded
} from '@openmetro/core';
import { fetchStationDetail } from './fetch.js';

export interface SuzhouSegmentMetric {
  from_stop_id: string;
  to_stop_id: string;
  travel_time_seconds: number;
  distance_km?: number;
  source_id: string;
}

export interface SuzhouOfficialTimes {
  segments: SuzhouSegmentMetric[];
  /** Fallback walk for unpublished in-station transfers (official map average). */
  transfers: HarvestedTransferTime[];
  fetchedDetailCount: number;
  pairedSegmentCount: number;
}

/** Official map note: interchange assumed at 5 minutes when unpublished. */
export const SUZHOU_DEFAULT_TRANSFER_SECONDS = 300;
export const SUZHOU_TRANSFER_SOURCE = 'sz-mtr-map-transfer-5min';
export const SUZHOU_SEGMENT_SOURCE = 'sz-mtr-station-detail';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StationRunMetrics {
  upTime?: number;
  downTime?: number;
  upMove?: number;
  downMove?: number;
  stationLine?: string;
  stationName?: string;
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseDetail(data: Record<string, unknown> | null): StationRunMetrics | null {
  if (!data) return null;
  return {
    upTime: num(data.upTime),
    downTime: num(data.downTime),
    upMove: num(data.upMove),
    downMove: num(data.downMove),
    stationLine: data.stationLine == null ? undefined : String(data.stationLine),
    stationName: data.stationName == null ? undefined : String(data.stationName)
  };
}

/**
 * Collect official adjacent-segment metrics for every pattern stop pair.
 * Also emits the documented 5-minute same-station transfer fallback.
 */
export async function collectSuzhouOfficialTimes(opts: {
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id' | 'source_id' | 'sequence'>[];
  patterns: Pick<PatternEncoded, 'id' | 'stop_ids' | 'line_id'>[];
  delayMs?: number;
  concurrency?: number;
}): Promise<SuzhouOfficialTimes> {
  const stopById = new Map(opts.stops.map((s) => [s.id, s]));
  const pairs = adjacentStopPairs(opts.patterns as PatternEncoded[]);
  const codes = new Set<string>();
  for (const p of pairs) {
    const a = stopById.get(p.from_stop_id)?.source_id;
    const b = stopById.get(p.to_stop_id)?.source_id;
    if (a) codes.add(a);
    if (b) codes.add(b);
  }

  console.log(`  fetch station-detail metrics (${codes.size} codes, ${pairs.length} pairs)`);
  const details = new Map<string, StationRunMetrics>();
  const delayMs = opts.delayMs ?? 40;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const queue = [...codes];
  let next = 0;
  let fetched = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= queue.length) return;
      const code = queue[i];
      try {
        const raw = await fetchStationDetail(code);
        const parsed = parseDetail(raw);
        if (parsed) details.set(code, parsed);
        fetched++;
      } catch (err) {
        console.warn(`  station-detail ${code} failed: ${err}`);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker())
  );

  const segments: SuzhouSegmentMetric[] = [];
  let paired = 0;
  for (const pair of pairs) {
    const fromStop = stopById.get(pair.from_stop_id);
    const toStop = stopById.get(pair.to_stop_id);
    if (!fromStop || !toStop) continue;
    const fromCode = fromStop.source_id;
    const toCode = toStop.source_id;
    const fromDetail = fromCode ? details.get(fromCode) : undefined;
    const toDetail = toCode ? details.get(toCode) : undefined;

    // Pattern order follows the map: first → last. On a linear line that is
    // the "down" direction from the earlier stop and "up" from the later one.
    const times: number[] = [];
    const dists: number[] = [];
    if (fromDetail?.downTime != null && fromDetail.downTime > 0) times.push(fromDetail.downTime);
    if (toDetail?.upTime != null && toDetail.upTime > 0) times.push(toDetail.upTime);
    if (fromDetail?.downMove != null && fromDetail.downMove > 0) dists.push(fromDetail.downMove);
    if (toDetail?.upMove != null && toDetail.upMove > 0) dists.push(toDetail.upMove);
    if (times.length === 0) continue;

    const seconds = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const meters = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : undefined;
    paired++;
    segments.push({
      from_stop_id: pair.from_stop_id,
      to_stop_id: pair.to_stop_id,
      travel_time_seconds: seconds,
      distance_km: meters != null ? Math.round((meters / 1000) * 1000) / 1000 : undefined,
      source_id: SUZHOU_SEGMENT_SOURCE
    });
  }

  // Same-station interchange walk: operator map states 5 minutes on average
  // when a pair-specific time is unpublished.
  const transfers: HarvestedTransferTime[] = (opts.stops ?? []).length
    ? missingTransferFallback(opts.stops)
    : [];

  return {
    segments,
    transfers,
    fetchedDetailCount: fetched,
    pairedSegmentCount: paired
  };
}

/** Build 5-min fallback edges for every same-station line pair (adapter fills nulls later). */
function missingTransferFallback(
  stops: Pick<StopEncoded, 'station_id' | 'line_id'>[]
): HarvestedTransferTime[] {
  const byStation = new Map<string, Set<string>>();
  for (const s of stops) {
    const set = byStation.get(s.station_id) ?? new Set<string>();
    set.add(s.line_id);
    byStation.set(s.station_id, set);
  }
  const out: HarvestedTransferTime[] = [];
  for (const [station_id, lines] of byStation) {
    const arr = [...lines];
    if (arr.length < 2) continue;
    for (const from_line_id of arr) {
      for (const to_line_id of arr) {
        if (from_line_id === to_line_id) continue;
        out.push({
          station_id,
          from_line_id,
          to_line_id,
          walk_time_seconds: SUZHOU_DEFAULT_TRANSFER_SECONDS,
          source_id: SUZHOU_TRANSFER_SOURCE
        });
      }
    }
  }
  return out;
}
