/**
 * Harvest official segment / transfer times from operator route planners.
 *
 * Adapters query only the OD pairs needed to cover every ride edge and every
 * missing transfer walk — not the full fare matrix — so topology/enrichment
 * syncs stay cheap while fares sync remains a separate full-matrix pass.
 */
import type {
  PatternEncoded,
  SegmentEncoded,
  StopEncoded,
  TransferEncoded
} from '../schema/index.js';

/** One planner-sourced ride time between two consecutive stops on one line. */
export interface HarvestedSegmentTime {
  from_stop_id: string;
  to_stop_id: string;
  travel_time_seconds: number;
  /** Stable operator/planner identifier, e.g. `shmetro-plantrip`. */
  source_id: string;
}

/** One planner-sourced transfer walk time at a station. */
export interface HarvestedTransferTime {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  walk_time_seconds: number;
  source_id: string;
}

export interface PlannerTimes {
  segments: HarvestedSegmentTime[];
  transfers: HarvestedTransferTime[];
}

/** Bounded worker pool with an optional inter-task delay. */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: { concurrency: number; delayMs?: number }
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Consecutive stop pairs on each pattern, deduplicated by unordered stop pair
 * (both directions of a linear pattern share one ride time).
 */
export function adjacentStopPairs(
  patterns: Pick<PatternEncoded, 'stop_ids'>[]
): { from_stop_id: string; to_stop_id: string }[] {
  const seen = new Set<string>();
  const out: { from_stop_id: string; to_stop_id: string }[] = [];
  for (const p of patterns) {
    for (let i = 0; i < p.stop_ids.length - 1; i++) {
      const a = p.stop_ids[i];
      const b = p.stop_ids[i + 1];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from_stop_id: a, to_stop_id: b });
    }
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Overwrite non-authoritative segment times (`last_train` / `estimated`) with
 * planner values. Official `source` times are left untouched.
 */
export function applyHarvestedSegmentTimes(
  segments: SegmentEncoded[],
  harvested: readonly HarvestedSegmentTime[]
): { segments: SegmentEncoded[]; applied: number } {
  const byPair = new Map<string, HarvestedSegmentTime>();
  for (const h of harvested) {
    if (!(h.travel_time_seconds > 0)) continue;
    const key = pairKey(h.from_stop_id, h.to_stop_id);
    // Prefer the first successful sample; later queries should agree.
    if (!byPair.has(key)) byPair.set(key, h);
  }
  let applied = 0;
  const out = segments.map((s) => {
    if (s.travel_time_source === 'source') return s;
    const hit = byPair.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!hit) return s;
    applied++;
    return {
      ...s,
      travel_time_seconds: hit.travel_time_seconds,
      travel_time_source: 'planner' as const,
      travel_time_derived_from: undefined,
      source_id: s.source_id ?? hit.source_id,
      extras: {
        ...(s.extras ?? {}),
        planner_time_source: hit.source_id
      }
    };
  });
  return { segments: out, applied };
}

/**
 * Fill `walk_time_seconds` on transfer edges that have none yet. Existing
 * official times (e.g. Beijing `interchange.xml`) always win.
 */
export function applyHarvestedTransferTimes(
  transfers: TransferEncoded[],
  harvested: readonly HarvestedTransferTime[]
): { transfers: TransferEncoded[]; applied: number } {
  const byKey = new Map<string, HarvestedTransferTime>();
  for (const h of harvested) {
    if (!(h.walk_time_seconds > 0)) continue;
    const key = `${h.station_id}|${h.from_line_id}|${h.to_line_id}`;
    if (!byKey.has(key)) byKey.set(key, h);
  }
  let applied = 0;
  const out = transfers.map((t) => {
    if (t.walk_time_seconds != null) return t;
    const hit = byKey.get(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`);
    if (!hit) return t;
    applied++;
    return {
      ...t,
      walk_time_seconds: hit.walk_time_seconds,
      // Provenance of the walk time (not of the edge itself).
      source_id: hit.source_id
    };
  });
  return { transfers: out, applied };
}

/** Interchange stations with ordered line pairs that still lack a walk time. */
export function missingTransferPairs(
  transfers: Pick<
    TransferEncoded,
    'station_id' | 'from_line_id' | 'to_line_id' | 'walk_time_seconds'
  >[]
): { station_id: string; from_line_id: string; to_line_id: string }[] {
  return transfers
    .filter((t) => t.walk_time_seconds == null)
    .map((t) => ({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id
    }));
}

/** Stop id for a station on a line, from the canonical stop table. */
export function stopOnLine(
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id'>[],
  stationId: string,
  lineId: string
): string | undefined {
  return stops.find((s) => s.station_id === stationId && s.line_id === lineId)?.id;
}

/**
 * Neighbour stop along a line, walking `steps` positions in `direction`
 * from `stopId` on the given pattern (or any pattern containing it).
 */
export function neighbourStop(
  patterns: Pick<PatternEncoded, 'stop_ids'>[],
  stopId: string,
  direction: -1 | 1,
  steps = 1
): string | undefined {
  for (const p of patterns) {
    const i = p.stop_ids.indexOf(stopId);
    if (i < 0) continue;
    const j = i + direction * steps;
    if (j < 0 || j >= p.stop_ids.length) continue;
    return p.stop_ids[j];
  }
  return undefined;
}
