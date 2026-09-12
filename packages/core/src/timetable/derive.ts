import type {
  PatternEncoded,
  SegmentEncoded,
  StopEncoded,
  TimetableEncoded,
} from "../schema/index.js";
import type { DirectionType } from "../schema/timetable.js";
import { normalizeTimetableTimes, parseHHMM } from "./time.js";

export interface DerivedSegment {
  id: string;
  line_id: string;
  from_stop_id: string;
  to_stop_id: string;
  from_station_id: string;
  to_station_id: string;
  travel_time_seconds: number;
  travel_time_source: "last_train";
  travel_time_derived_from: [string, string];
}

export interface DeriveOptions {
  /** Minimum plausible inter-station time in seconds (default 30). */
  minSeconds?: number;
  /** Maximum plausible inter-station time in seconds; larger = data gap (default 1200). */
  maxSeconds?: number;
}

const DEFAULTS: Required<DeriveOptions> = { minSeconds: 30, maxSeconds: 1200 };

interface Chain {
  order: readonly string[];
  records: Map<string, TimetableEncoded>;
}

/**
 * Walk an ordered list of stops and select, for each stop, the timetable record
 * whose last-train time keeps the chain monotonically non-decreasing. Records
 * that head toward `destinationStopId` (linear) or match `directionType` (loop)
 * are preferred; when none is available the remaining records are considered
 * and a non-monotonic entry is simply skipped.
 */
function selectChain(
  order: readonly string[],
  byStop: Map<string, TimetableEncoded[]>,
  destinationStopId: string | undefined,
  directionType: DirectionType | undefined,
): Chain {
  const selected = new Map<string, TimetableEncoded>();
  let prevTime: number | null = null;

  for (const stopId of order) {
    const recs = byStop.get(stopId) ?? [];
    // Prefer records matching the target direction (linear destination or loop type).
    const preferred = directionType
      ? recs.filter((r) => r.direction_type === directionType)
      : destinationStopId
        ? recs.filter((r) => r.destination_stop_id === destinationStopId)
        : [];
    const pool = preferred.length > 0 ? preferred : recs;

    let chosen: TimetableEncoded | undefined;
    let chosenTime: number | null = null;
    for (const r of pool) {
      const t = parseHHMM(r.last_train[0] ?? "");
      if (t == null) continue;
      if (prevTime != null && t < prevTime) continue;
      if (!chosen || (chosenTime != null && t < chosenTime)) {
        chosen = r;
        chosenTime = t;
      }
    }

    if (chosen) {
      selected.set(stopId, chosen);
      if (chosenTime != null) prevTime = chosenTime;
    }
  }

  return { order, records: selected };
}

/**
 * Derive per-segment travel times from last-train times of consecutive stops on
 * each route pattern. For every pattern the orientation (toward its terminal or
 * toward its origin) that covers the most stops is used, so branch patterns are
 * derived independently of the main alignment. For loop patterns, the direction
 * type (inner/outer) is used instead of terminal matching. Returns the derived
 * segment records (`travel_time_source = "last_train"`), deduplicated by stop pair.
 */
export function deriveSegmentTimes(
  patterns: PatternEncoded[],
  stops: StopEncoded[],
  timetables: TimetableEncoded[],
  opts: DeriveOptions = {},
): DerivedSegment[] {
  const cfg = { ...DEFAULTS, ...opts };
  const stopById = new Map(stops.map((s) => [s.id, s]));

  const byStop = new Map<string, TimetableEncoded[]>();
  for (const raw of timetables) {
    // Normalize after-midnight last trains to `24:xx`+ so a chain that crosses
    // midnight stays monotonically increasing.
    const t = normalizeTimetableTimes(raw);
    if (!t.stop_id) continue;
    const arr = byStop.get(t.stop_id) ?? [];
    arr.push(t);
    byStop.set(t.stop_id, arr);
  }

  const primaryStopsByLine = new Map<string, Set<string>>();
  for (const p of patterns) {
    if (p.is_primary) primaryStopsByLine.set(p.line_id, new Set(p.stop_ids));
  }

  const out = new Map<string, DerivedSegment>();

  for (const pattern of patterns) {
    // Check if this pattern is for a loop line (from pattern extras).
    const isLoop = (pattern.extras as { loop?: boolean } | undefined)?.loop === true;

    let forward: Chain;
    let backward: Chain;

    if (isLoop) {
      // For loop patterns, try both inner and outer directions, pick the one with more coverage.
      const forwardInner = selectChain(pattern.stop_ids, byStop, undefined, "loop_inner");
      const forwardOuter = selectChain(pattern.stop_ids, byStop, undefined, "loop_outer");
      const backwardInner = selectChain(
        [...pattern.stop_ids].reverse(),
        byStop,
        undefined,
        "loop_inner",
      );
      const backwardOuter = selectChain(
        [...pattern.stop_ids].reverse(),
        byStop,
        undefined,
        "loop_outer",
      );

      // Pick the best among all four options.
      const candidates = [forwardInner, forwardOuter, backwardInner, backwardOuter];
      const best = candidates.reduce((a, b) => (a.records.size >= b.records.size ? a : b));

      // For loop lines, we use the best match regardless of direction.
      forward = best;
      backward = { order: [], records: new Map() };
    } else {
      forward = selectChain(pattern.stop_ids, byStop, pattern.terminal_stop_id, undefined);
      backward = selectChain(
        [...pattern.stop_ids].reverse(),
        byStop,
        pattern.origin_stop_id,
        undefined,
      );
    }

    const best = forward.records.size >= backward.records.size ? forward : backward;

    for (let i = 0; i < best.order.length - 1; i++) {
      const a = stopById.get(best.order[i]);
      const b = stopById.get(best.order[i + 1]);
      if (!a || !b) continue;

      // The junction aggregates the last train of every service that calls
      // there, so a delta across a branch-junction connector is unreliable.
      const junction = pattern.junction_stop_id;
      if (junction && !pattern.is_primary) {
        const primary = primaryStopsByLine.get(pattern.line_id);
        const aBranch = primary ? !primary.has(a.id) : false;
        const bBranch = primary ? !primary.has(b.id) : false;
        if ((a.id === junction && bBranch) || (b.id === junction && aBranch)) continue;
      }

      const ta = best.records.get(a.id);
      const tb = best.records.get(b.id);
      if (!ta || !tb) continue;
      const taTime = parseHHMM(ta.last_train[0] ?? "");
      const tbTime = parseHHMM(tb.last_train[0] ?? "");
      if (taTime == null || tbTime == null) continue;
      const delta = tbTime - taTime;
      if (delta < cfg.minSeconds / 60 || delta > cfg.maxSeconds / 60) continue;
      const key = `${a.id}|${b.id}`;
      if (out.has(key)) continue;
      out.set(key, {
        id: `seg-${a.id}-${b.id}`,
        line_id: a.line_id,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        travel_time_seconds: delta * 60,
        travel_time_source: "last_train",
        travel_time_derived_from: [ta.id, tb.id],
      });
    }
  }

  return [...out.values()];
}

/**
 * Merge derived segment times into existing segment records (by stop pair).
 * Returns new segment records (does not mutate inputs). Existing segments keep
 * their `source` travel_time when present; derived times fill the gaps.
 */
export function applyDerivedTimes(
  segments: SegmentEncoded[],
  derived: DerivedSegment[],
): SegmentEncoded[] {
  const byPair = new Map<string, DerivedSegment>();
  for (const d of derived) {
    const key = `${d.from_stop_id}|${d.to_stop_id}`;
    if (!byPair.has(key)) byPair.set(key, d);
  }
  return segments.map((s) => {
    // Keep authoritative source times; override estimated/unset times with
    // derived last-train times so we never discard real data but always fill
    // gaps with a real derivation.
    if (s.travel_time_source === "source") return s;
    const d = byPair.get(`${s.from_stop_id}|${s.to_stop_id}`);
    if (!d) return s;
    return {
      ...s,
      travel_time_seconds: d.travel_time_seconds,
      travel_time_source: d.travel_time_source,
      travel_time_derived_from: d.travel_time_derived_from,
    };
  });
}

/**
 * Ensure every segment has a positive travel time.
 *
 * Some sources publish `0` as a placeholder for a segment they have not
 * measured yet (Beijing does this for newly opened sections). A zero-time edge
 * would be dropped by the graph builder and silently disconnect the network, so
 * such values are treated as unknown, filled from the last-train derivation,
 * and finally fall back to `defaultSeconds`.
 */
export function fillMissingSegmentTimes(
  segments: SegmentEncoded[],
  patterns: PatternEncoded[],
  stops: StopEncoded[],
  timetables: TimetableEncoded[],
  defaultSeconds = 120,
): SegmentEncoded[] {
  const unknown = segments.map((s) =>
    s.travel_time_seconds != null && s.travel_time_seconds > 0
      ? s
      : { ...s, travel_time_seconds: undefined, travel_time_source: undefined },
  );
  const derived = deriveSegmentTimes(patterns, stops, timetables, {});
  return applyDerivedTimes(unknown, derived).map((s) =>
    s.travel_time_seconds != null && s.travel_time_seconds > 0
      ? s
      : { ...s, travel_time_seconds: defaultSeconds, travel_time_source: "estimated" as const },
  );
}
