import type { NetworkData } from '../data/types.js';
import type { RouteLeg, RoutePlan } from '../graph/route.js';

/**
 * Service-aware enrichment for `/route` response legs: headsigns and
 * junction-correct splitting.
 *
 * A headsign is the destination a passenger reads off the front of the train /
 * the platform display — the endpoint the *service* you board is traveling
 * toward. It is **published data**, not topology: the operator decides whether
 * a train terminates at a junction or continues onto a branch, and the
 * canonical timetables record exactly that per boarding station
 * (`destination_stop_id` + `direction_label`). Patterns only supply geometry —
 * which routings exist and how the stops are ordered. Shearing each ride leg
 * against the published destinations is what makes its headsign truthful, so
 * `pattern_id` is an auxiliary (and, on shared trunks, possibly ambiguous),
 * never the source of truth.
 *
 * The builder also *splits* ride legs where the boarding service cannot carry
 * the leg through a junction, e.g. Line 11 花桥 → 嘉定北 has no through train —
 * the planner's same-line collapse would fabricate one continuous ride. The
 * split emits the ride up to the divergence, a same-station direction-change
 * transfer (marked `same_line_direction_change`), and a fresh ride carrying
 * the new service's headsign.
 *
 * Loop lines have no terminal, so their legs get no headsign (loop direction
 * is conveyed by the timetables' `direction_type`, not a destination).
 */

/** Enriched ride leg: the base leg plus service-derived fields. */
export type EnrichedRideLeg = RouteLeg & {
  kind: 'ride';
  pattern_id?: string;
  headsign_station_id?: string;
  headsign_names?: { zh: string; en: string };
};

/** Transfer legs inserted at a junction direction change carry this marker. */
export interface DirectionChangeTransferLeg extends RouteLeg {
  kind: 'transfer';
  same_line_direction_change: true;
}

export type EnrichedLeg = EnrichedRideLeg | DirectionChangeTransferLeg | RouteLeg;

export type EnrichedRoutePlan = Omit<RoutePlan, 'legs'> & { legs: EnrichedLeg[] };

interface NetworkIndex {
  stationOfStop: Map<string, string>;
  stationNames: Map<string, { zh: string; en: string }>;
  /** lineId -> stationId -> stopId (one stop per station + line). */
  stopByLineStation: Map<string, Map<string, string>>;
  /** patternId -> ordered stop ids. */
  patternStops: Map<string, string[]>;
  /** `${patternId}|${stopId}` -> index in the pattern. */
  patternIndex: Map<string, number>;
  /** lineId -> pattern ids, primary first. */
  patternsByLine: Map<string, string[]>;
  /** `${lineId}|${stationId}` -> published destination station ids, unique. */
  services: Map<string, string[]>;
  loopLines: Set<string>;
  /** `${lineId}|${fromStop}|${toStop}` -> travel seconds (both orientations). */
  segmentSeconds: Map<string, number>;
}

const KEY_PATTERN_STOP = (p: string, s: string) => `${p}|${s}`;
const KEY_SERVICE = (line: string, station: string) => `${line}|${station}`;
const KEY_SEGMENT = (line: string, a: string, b: string) => `${line}|${a}|${b}`;

function buildIndex(data: NetworkData): NetworkIndex {
  const stationOfStop = new Map<string, string>();
  const stopByLineStation = new Map<string, Map<string, string>>();
  for (const s of data.stops) {
    stationOfStop.set(s.id, s.station_id);
    let byLine = stopByLineStation.get(s.line_id);
    if (!byLine) {
      byLine = new Map();
      stopByLineStation.set(s.line_id, byLine);
    }
    byLine.set(s.station_id, s.id);
  }

  const patternStops = new Map<string, string[]>();
  const patternIndex = new Map<string, number>();
  const patternsByLine = new Map<string, string[]>();
  const byLine = new Map<string, typeof data.patterns>();
  for (const p of data.patterns) {
    const list = byLine.get(p.line_id) ?? [];
    list.push(p);
    byLine.set(p.line_id, list);
  }
  for (const [lineId, patterns] of byLine) {
    patterns.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    patternsByLine.set(
      lineId,
      patterns.map((p) => p.id)
    );
    for (const p of patterns) {
      patternStops.set(p.id, [...p.stop_ids]);
      p.stop_ids.forEach((s, i) => {
        patternIndex.set(KEY_PATTERN_STOP(p.id, s), i);
      });
    }
  }

  const services = new Map<string, string[]>();
  for (const t of data.timetables) {
    if (!t.destination_stop_id) continue;
    const destinationStation = stationOfStop.get(t.destination_stop_id);
    if (!destinationStation) continue;
    const key = KEY_SERVICE(t.line_id, t.station_id);
    const list = services.get(key) ?? [];
    if (!list.includes(destinationStation)) list.push(destinationStation);
    services.set(key, list);
  }

  const segmentSeconds = new Map<string, number>();
  for (const seg of data.segments) {
    if (seg.travel_time_seconds == null) continue;
    if (seg.direction !== 'backward') {
      segmentSeconds.set(
        KEY_SEGMENT(seg.line_id, seg.from_stop_id, seg.to_stop_id),
        seg.travel_time_seconds
      );
    }
    if (seg.direction !== 'forward') {
      segmentSeconds.set(
        KEY_SEGMENT(seg.line_id, seg.to_stop_id, seg.from_stop_id),
        seg.travel_time_seconds
      );
    }
  }

  return {
    stationOfStop,
    stationNames: new Map(data.stations.map((s) => [s.id, s.names])),
    stopByLineStation,
    patternStops,
    patternIndex,
    patternsByLine,
    services,
    loopLines: new Set(data.lines.filter((l) => l.loop).map((l) => l.id)),
    segmentSeconds
  };
}

const hosts = (idx: NetworkIndex, patternId: string, stopId: string): boolean =>
  idx.patternIndex.has(KEY_PATTERN_STOP(patternId, stopId));

const indexOf = (idx: NetworkIndex, patternId: string, stopId: string): number =>
  idx.patternIndex.get(KEY_PATTERN_STOP(patternId, stopId)) ?? -1;

function lineStopOf(idx: NetworkIndex, lineId: string, stationId: string): string | undefined {
  return idx.stopByLineStation.get(lineId)?.get(stationId);
}

function stationOf(idx: NetworkIndex, stopId: string): string | undefined {
  return idx.stationOfStop.get(stopId);
}

interface HopResolution {
  /** Destination station the boarding service travels toward. */
  headsign_station_id?: string;
  /** Pattern that pinned the direction/headsign. */
  pattern_id?: string;
}

/**
 * Resolve the service destination a passenger boards at `fromStop` when
 * traveling toward `toStop` on `lineId`.
 *
 * Published-first: the destination must be one of the operator's published
 * destinations at the boarding station AND lie ahead of the boarding stop in
 * the leg's direction (decided by pattern stop order). When several published
 * destinations qualify (shared trunks, e.g. Line 11 toward the two northern
 * branches), the one whose pattern also serves `toStop` wins, then primary
 * pattern preference. If published data is missing, falls back to the
 * geometric pattern endpoint.
 */
function resolveHop(
  idx: NetworkIndex,
  lineId: string,
  fromStop: string,
  toStop: string
): HopResolution {
  const fromStation = stationOf(idx, fromStop);
  if (!fromStation) return {};
  const published = (idx.services.get(KEY_SERVICE(lineId, fromStation)) ?? []).filter((d) =>
    idx.stationNames.has(d)
  );
  const patterns = idx.patternsByLine.get(lineId) ?? [];
  const hosting = patterns.filter((p) => hosts(idx, p, fromStop));

  // Direction the leg leaves the boarding stop, relative to each pattern.
  // A pattern that does not host `toStop` cannot pin direction (junction
  // crossing) and is skipped.
  const directionOf = (p: string): 1 | -1 | 0 => {
    if (!hosts(idx, p, toStop)) return 0;
    const iF = indexOf(idx, p, fromStop);
    const iT = indexOf(idx, p, toStop);
    return iT > iF ? 1 : iT < iF ? -1 : 0;
  };

  const aheadPublished = published.filter((d) => {
    const dStop = lineStopOf(idx, lineId, d);
    if (!dStop) return false;
    return hosting.some((p) => {
      const dir = directionOf(p);
      if (dir === 0) return false;
      const iD = indexOf(idx, p, dStop);
      const iF = indexOf(idx, p, fromStop);
      return dir === 1 ? iD > iF : iD < iF;
    });
  });

  if (aheadPublished.length > 0) {
    // Prefer a destination whose pattern also serves the leg's destination stop.
    const covering = aheadPublished.filter((d) => {
      const dStop = lineStopOf(idx, lineId, d);
      return (
        dStop != null &&
        hosting.some((p) => directionOf(p) !== 0 && hosts(idx, p, dStop) && hosts(idx, p, toStop))
      );
    });
    const chosen = covering[0] ?? aheadPublished[0];
    const chosenStop = lineStopOf(idx, lineId, chosen);
    const pattern = hosting.find((p) => {
      if (!chosenStop) return false;
      const dir = directionOf(p);
      const iC = indexOf(idx, p, chosenStop);
      const iF = indexOf(idx, p, fromStop);
      return dir === 1 ? iC > iF : dir === -1 ? iC < iF : false;
    });
    return { headsign_station_id: chosen, pattern_id: pattern };
  }

  // Fallback: geometric endpoint of the best-fitting pattern (no published data).
  const withTo = hosting
    .map((p) => ({ p, gap: Math.abs(indexOf(idx, p, toStop) - indexOf(idx, p, fromStop)) }))
    .filter((x) => hosts(idx, x.p, toStop))
    .sort((a, b) => b.gap - a.gap);
  const pattern = withTo[0]?.p ?? hosting[0];
  if (!pattern) return {};
  const stops = idx.patternStops.get(pattern) ?? [];
  const iF = indexOf(idx, pattern, fromStop);
  const forward = hosts(idx, pattern, toStop) ? indexOf(idx, pattern, toStop) > iF : true;
  const endpointStop = forward ? stops[stops.length - 1] : stops[0];
  const headsign = endpointStop != null ? stationOf(idx, endpointStop) : undefined;
  return { headsign_station_id: headsign, pattern_id: pattern };
}

/** Reconstruct the ordered stop sequence of a ride leg (from/to + interiors). */
function stopSequence(idx: NetworkIndex, leg: RouteLeg): string[] {
  const stops = [leg.from_stop_id];
  if (leg.station_ids) {
    for (const stationId of leg.station_ids.slice(1, -1)) {
      const stop = lineStopOf(idx, leg.line_id ?? '', stationId);
      if (stop && stop !== stops[stops.length - 1]) stops.push(stop);
    }
  }
  if (leg.to_stop_id !== stops[stops.length - 1]) stops.push(leg.to_stop_id);
  return stops;
}

/** Seconds for a consecutive stop pair, with a proportional fallback. */
function hopSeconds(
  idx: NetworkIndex,
  lineId: string,
  stops: string[],
  from: number,
  to: number,
  legSeconds: number
): number {
  let acc = 0;
  let known = 0;
  for (let i = from; i < to; i++) {
    const s = idx.segmentSeconds.get(KEY_SEGMENT(lineId, stops[i], stops[i + 1]));
    if (s != null) {
      acc += s;
      known++;
    }
  }
  if (known === to - from) return acc;
  return Math.round((legSeconds * (to - from)) / Math.max(1, stops.length - 1));
}

/** Best single pattern containing both halves of the leg (others → first host). */
function interiorPattern(idx: NetworkIndex, lineId: string, leg: RouteLeg): string | undefined {
  const patterns = idx.patternsByLine.get(lineId) ?? [];
  const both = patterns.filter(
    (p) => hosts(idx, p, leg.from_stop_id) && hosts(idx, p, leg.to_stop_id)
  );
  if (both.length > 0) return both[0];
  return patterns.find((p) => hosts(idx, p, leg.from_stop_id));
}

/** Geometric endpoint station (direction-aware) of a pattern. */
function patternEndpoint(
  idx: NetworkIndex,
  lineId: string,
  leg: RouteLeg,
  preferred?: string
): string | undefined {
  const pattern =
    preferred ?? interiorPattern(idx, lineId, leg) ?? idx.patternsByLine.get(lineId)?.[0];
  if (!pattern) return undefined;
  const stops = idx.patternStops.get(pattern) ?? [];
  const iF = indexOf(idx, pattern, leg.from_stop_id);
  if (iF < 0 || stops.length === 0) return undefined;
  const forward = hosts(idx, pattern, leg.to_stop_id)
    ? indexOf(idx, pattern, leg.to_stop_id) > iF
    : true;
  return stationOf(idx, forward ? stops[stops.length - 1] : stops[0]);
}

function annotateRide(
  idx: NetworkIndex,
  leg: RouteLeg,
  patternId: string | undefined,
  headsign: string | undefined,
  stops?: string[],
  from = 0,
  to = stops ? stops.length - 1 : 0
): EnrichedRideLeg {
  const subStops = stops ? stops.slice(from, to + 1) : undefined;
  const head = subStops ? subStops[0] : undefined;
  const tail = subStops && subStops.length >= 2 ? subStops[subStops.length - 1] : undefined;
  const enriched: EnrichedRideLeg = {
    ...leg,
    kind: 'ride',
    ...(patternId ? { pattern_id: patternId } : {}),
    ...(headsign ? { headsign_station_id: headsign } : {}),
    ...(headsign ? { headsign_names: idx.stationNames.get(headsign) } : {})
  };
  if (head && tail && subStops) {
    enriched.from_stop_id = head;
    enriched.to_stop_id = tail;
    enriched.from_station_id = stationOf(idx, head) ?? leg.from_station_id;
    enriched.to_station_id = stationOf(idx, tail) ?? leg.to_station_id;
    enriched.station_ids = subStops.map((s) => stationOf(idx, s) ?? '').filter((s) => s !== '');
    enriched.seconds = hopSeconds(
      idx,
      leg.line_id ?? '',
      subStops,
      0,
      subStops.length - 1,
      leg.seconds
    );
  }
  return enriched;
}

/** Split one ride leg where its boarding service cannot carry it, then annotate. */
function processRideLeg(idx: NetworkIndex, leg: RouteLeg): EnrichedLeg[] {
  const lineId = leg.line_id;
  if (!lineId || idx.loopLines.has(lineId)) {
    return [annotateRide(idx, leg, interiorPattern(idx, lineId ?? '', leg), undefined)];
  }

  const stops = stopSequence(idx, leg);
  if (stops.length < 2) {
    const resolved = resolveHop(idx, lineId, leg.from_stop_id, leg.to_stop_id);
    const headsign =
      resolved.headsign_station_id ?? patternEndpoint(idx, lineId, leg, resolved.pattern_id);
    return [annotateRide(idx, leg, resolved.pattern_id, headsign)];
  }

  const out: EnrichedLeg[] = [];
  let start = 0;
  while (start < stops.length - 1) {
    let end = start + 1;
    const first = resolveHop(idx, lineId, stops[start], stops[end]);
    const currentHeadsign = first.headsign_station_id;

    while (end < stops.length - 1) {
      const next = end + 1;
      const here = resolveHop(idx, lineId, stops[end], stops[next]);
      if (currentHeadsign == null || here.headsign_station_id !== currentHeadsign) break;
      end = next;
    }

    out.push(annotateRide(idx, leg, first.pattern_id, currentHeadsign, stops, start, end));
    if (end < stops.length - 1) {
      const splitStop = stops[end];
      const splitStation = stationOf(idx, splitStop) ?? '';
      const transfer: DirectionChangeTransferLeg = {
        kind: 'transfer',
        line_id: lineId,
        from_stop_id: splitStop,
        to_stop_id: splitStop,
        from_station_id: splitStation,
        to_station_id: splitStation,
        seconds: 0,
        same_line_direction_change: true
      };
      out.push(transfer);
    }
    start = end;
  }
  return out;
}

/** Annotate and split the ride legs of a route plan; transfer legs pass through. */
export function enrichRoutePlan(data: NetworkData, plan: RoutePlan): EnrichedRoutePlan {
  const idx = buildIndex(data);
  const legs: EnrichedLeg[] = [];
  for (const leg of plan.legs) {
    if (leg.kind === 'ride') {
      legs.push(...processRideLeg(idx, leg));
    } else {
      legs.push(leg);
    }
  }
  // Re-count: junction direction changes add same-station transfer legs.
  const transfers = legs.reduce((n, leg) => n + (leg.kind === 'transfer' ? 1 : 0), 0);
  return { ...plan, legs, transfers };
}
