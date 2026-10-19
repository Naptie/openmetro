import { parseHHMM } from './time.js';

export interface TimetableDirectionCoverageInput {
  lines?: readonly { id: string; loop?: boolean; status?: string }[];
  stations?: readonly { id?: string; status?: string }[];
  stops?: readonly { id?: string; station_id?: string; line_id?: string }[];
  segments: readonly {
    line_id?: string;
    from_stop_id?: string;
    to_stop_id?: string;
    direction?: string;
  }[];
  timetables?: readonly {
    id?: string;
    stop_id?: string;
    line_id?: string;
    destination_stop_id?: string;
    direction_type?: string;
    is_arrival?: boolean;
    first_train?: unknown;
    last_train?: unknown;
  }[];
}

export interface TimetableDirection {
  stop_id: string;
  line_id: string;
  /** A next-stop id, loop_inner/loop_outer, or unknown for an isolated stop. */
  direction: string;
  has_first: boolean;
  has_last: boolean;
  /** At least one departure record supplies both first and last trains. */
  complete: boolean;
  /** The graph and published rows do not resolve this departure direction. */
  unknown: boolean;
}

export interface TimetableDirectionCoverage {
  graph_available: boolean;
  directions: TimetableDirection[];
  required: number;
  covered: number;
  missing: TimetableDirection[];
  unknown: TimetableDirection[];
  /** Rows whose first departure edge cannot be resolved from their destination. */
  unresolved_timetables: string[];
}

const hasTime = (value: unknown) =>
  Array.isArray(value) &&
  (value.length === 1 || value.length === 7) &&
  value.some((time) => typeof time === 'string' && parseHHMM(time.replace('：', ':')) != null);

/**
 * Count departures by the feasible outgoing edges of each stop, not by all
 * terminal pairs. In a branching line, several destinations can share the same
 * first edge; a branch endpoint therefore does not need through trains to every
 * leaf. A destination resolves an edge only when exactly one neighbor can reach
 * it without revisiting the departure stop. Ambiguous cycles require explicit
 * loop directions instead of crediting one row to both sides of a ring.
 */
export function computeTimetableDirectionCoverage(
  input: TimetableDirectionCoverageInput
): TimetableDirectionCoverage {
  const empty: TimetableDirectionCoverage = {
    graph_available: false,
    directions: [],
    required: 0,
    covered: 0,
    missing: [],
    unknown: [],
    unresolved_timetables: []
  };
  const stops = input.stops ?? [];
  if (!stops.length || stops.some((stop) => !stop.id || !stop.line_id) || !input.segments.length)
    return empty;
  const stopById = new Map(stops.map((stop) => [stop.id!, stop]));
  if (
    input.segments.some((segment) => {
      const from = stopById.get(segment.from_stop_id ?? ''),
        to = stopById.get(segment.to_stop_id ?? '');
      return (
        !segment.line_id ||
        !from ||
        !to ||
        from.line_id !== segment.line_id ||
        to.line_id !== segment.line_id ||
        (segment.direction != null && !['both', 'forward', 'backward'].includes(segment.direction))
      );
    })
  )
    return empty;

  const lineById = new Map((input.lines ?? []).map((line) => [line.id, line]));
  const stationById = new Map((input.stations ?? []).map((station) => [station.id, station]));
  const operating = (status: string | undefined) => status == null || status === 'operating';
  const activeStops = stops.filter(
    (stop) =>
      operating(lineById.get(stop.line_id!)?.status) &&
      operating(stationById.get(stop.station_id)?.status)
  );
  // Station status controls boarding, not the existence of a through segment.
  // A temporarily closed intermediate station must not disconnect the line.
  const activeIds = new Set(activeStops.map((stop) => stop.id!));
  const traversable = stops.filter((stop) => {
    const status = stationById.get(stop.station_id)?.status;
    return status !== 'planned' && status !== 'under_construction';
  });
  const outgoing = new Map(traversable.map((stop) => [stop.id!, new Set<string>()]));
  const incoming = new Set<string>();
  const connect = (from: string, to: string) => {
    if (from === to || !outgoing.has(from) || !outgoing.has(to)) return;
    outgoing.get(from)!.add(to);
    incoming.add(to);
  };
  for (const segment of input.segments) {
    if (segment.direction !== 'backward') connect(segment.from_stop_id!, segment.to_stop_id!);
    if (segment.direction !== 'forward') connect(segment.to_stop_id!, segment.from_stop_id!);
  }

  const reaches = (start: string, avoid: string, matches: (stopId: string) => boolean) => {
    const visited = new Set([avoid]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      if (visited.has(current)) continue;
      if (matches(current)) return true;
      visited.add(current);
      for (const next of outgoing.get(current) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    return false;
  };

  const loopLines = new Set((input.lines ?? []).filter((line) => line.loop).map((line) => line.id));
  for (const row of input.timetables ?? []) {
    if (row.direction_type === 'loop_inner' || row.direction_type === 'loop_outer') {
      const line = stopById.get(row.stop_id ?? '')?.line_id;
      if (line) loopLines.add(line);
    }
  }
  const byStop = new Map<string, Map<string, TimetableDirection>>();
  for (const stop of activeStops) {
    const neighbors = [...outgoing.get(stop.id!)!].filter((next) =>
      reaches(next, stop.id!, (id) => activeIds.has(id))
    );
    const directions = loopLines.has(stop.line_id!)
      ? ['loop_inner', 'loop_outer']
      : neighbors.length || incoming.has(stop.id!)
        ? neighbors
        : ['unknown'];
    byStop.set(
      stop.id!,
      new Map(
        directions.map((direction) => [
          direction,
          {
            stop_id: stop.id!,
            line_id: stop.line_id!,
            direction,
            has_first: false,
            has_last: false,
            complete: false,
            unknown: direction === 'unknown'
          }
        ])
      )
    );
  }

  const unresolved: string[] = [];
  for (const row of input.timetables ?? []) {
    if (row.is_arrival || !row.stop_id || !byStop.has(row.stop_id)) continue;
    const stop = stopById.get(row.stop_id)!;
    let direction: string | undefined;
    if (!row.line_id || row.line_id === stop.line_id) {
      if (loopLines.has(stop.line_id!)) {
        direction = row.direction_type;
      } else if (
        row.destination_stop_id &&
        row.destination_stop_id !== row.stop_id &&
        stopById.get(row.destination_stop_id)?.line_id === stop.line_id
      ) {
        const candidates = [...outgoing.get(row.stop_id)!].filter((next) =>
          reaches(next, row.stop_id!, (id) => id === row.destination_stop_id)
        );
        if (candidates.length === 1) direction = candidates[0];
      }
    }
    const coverage = direction ? byStop.get(row.stop_id)!.get(direction) : undefined;
    if (!coverage) {
      unresolved.push(
        row.id ?? `${row.stop_id} -> ${row.destination_stop_id ?? row.direction_type ?? '?'}`
      );
      for (const candidate of byStop.get(row.stop_id)!.values())
        if (!candidate.complete) candidate.unknown = true;
      continue;
    }
    const first = hasTime(row.first_train),
      last = hasTime(row.last_train);
    coverage.has_first ||= first;
    coverage.has_last ||= last;
    coverage.complete ||= first && last;
    if (coverage.complete) coverage.unknown = false;
  }
  const directions = [...byStop.values()].flatMap((values) => [...values.values()]);
  const missing = directions.filter((direction) => !direction.complete && !direction.unknown);
  const unknown = directions.filter((direction) => !direction.complete && direction.unknown);
  return {
    graph_available: true,
    directions,
    required: directions.length,
    covered: directions.filter((direction) => direction.complete).length,
    missing,
    unknown,
    unresolved_timetables: unresolved
  };
}
