import type { NetworkData } from '../data/types.js';
import type { RouteLeg, RoutePlan } from '../graph/route.js';
import { isStationRoutable } from '../schema/station.js';

/**
 * Service-aware enrichment for `/route` response legs: headsigns and
 * junction-correct splitting.
 *
 * A headsign is the destination a passenger reads off the front of the train /
 * the platform display — the endpoint the *service* you board is traveling
 * toward. It is **published data**, not topology: the operator decides whether
 * a train terminates at a junction or continues onto a branch, and the
 * canonical timetables record exactly that per boarding station
 * (`destination_stop_id` + `direction_label`). Patterns supply ordered calls;
 * `geometry_only` patterns are display alignments. Shearing each ride leg
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
  /** `${lineId}|${stationId}` -> published boarding services. */
  services: Map<string, { destination: string; pattern_id?: string }[]>;
  /** Lines with separate display geometry and actual calling patterns. */
  throughServiceLines: Set<string>;
  operatingStops: Set<string>;
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
  const operatingStations = new Set(
    data.stations.filter((s) => isStationRoutable(s.status)).map((s) => s.id)
  );
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
    if (p.extras?.geometry_only === true) continue;
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

  const services: NetworkIndex['services'] = new Map();
  for (const t of data.timetables) {
    if (!t.destination_stop_id) continue;
    const destinationStation = stationOfStop.get(t.destination_stop_id);
    if (!destinationStation) continue;
    const key = KEY_SERVICE(t.line_id, t.station_id);
    const list = services.get(key) ?? [];
    if (!list.some((s) => s.destination === destinationStation && s.pattern_id === t.pattern_id))
      list.push({ destination: destinationStation, pattern_id: t.pattern_id });
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
    throughServiceLines: new Set(
      data.patterns.filter((p) => p.extras?.geometry_only === true).map((p) => p.line_id)
    ),
    operatingStops: new Set(
      data.stops.filter((s) => operatingStations.has(s.station_id)).map((s) => s.id)
    ),
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

interface ServiceResolution {
  /** Destination station the boarding service travels toward. */
  headsign_station_id?: string;
  /** Pattern that pinned the direction/headsign. */
  pattern_id?: string;
  /** Last stop in the ride sequence this boarding service can reach. */
  end: number;
}

/**
 * Pick the published boarding service that covers the longest continuous
 * prefix of the remaining ride. Short turns must not displace a through train,
 * and intermediate stations need not repeat that train's destination row.
 */
function resolveService(
  idx: NetworkIndex,
  lineId: string,
  stops: string[],
  start: number
): ServiceResolution {
  const fromStop = stops[start]!;
  const fromStation = stationOf(idx, fromStop);
  const patterns = idx.patternsByLine.get(lineId) ?? [];
  const hosting = patterns.filter((p) => hosts(idx, p, fromStop));
  const published = fromStation ? (idx.services.get(KEY_SERVICE(lineId, fromStation)) ?? []) : [];
  let best: ServiceResolution = { end: start };
  const pathBetween = (pattern: string, from: string, to: string) => {
    const order = idx.patternStops.get(pattern)!;
    const a = indexOf(idx, pattern, from),
      b = indexOf(idx, pattern, to);
    return a <= b ? order.slice(a, b + 1) : order.slice(b, a + 1).reverse();
  };
  const consider = (pattern: string, destination: string) => {
    const destStop = lineStopOf(idx, lineId, destination);
    if (!destStop) return;
    // Metro branch geometry may end at the junction while the published train
    // continues down the trunk. Join there without changing its headsign.
    const paths = hosts(idx, pattern, destStop)
      ? [pathBetween(pattern, fromStop, destStop)]
      : patterns
          .filter((p) => hosts(idx, p, destStop))
          .flatMap((p) =>
            idx.patternStops
              .get(pattern)!
              .filter((s) => hosts(idx, p, s))
              .map((junction) => [
                ...pathBetween(pattern, fromStop, junction),
                ...pathBetween(p, junction, destStop).slice(1)
              ])
          );
    for (const path of paths) {
      if (new Set(path).size !== path.length) continue;
      let end = start;
      while (end + 1 < stops.length && path[end + 1 - start] === stops[end + 1]) end++;
      if (end > best.end) best = { end, headsign_station_id: destination, pattern_id: pattern };
    }
  };
  for (const pattern of hosting) {
    for (const service of published) {
      const destStop = lineStopOf(idx, lineId, service.destination);
      // Older metro patterns can describe only a branch. A full service
      // pattern, when present, pins the train's actual calling sequence.
      const servicePattern = service.pattern_id;
      if (
        servicePattern &&
        destStop &&
        hosts(idx, servicePattern, fromStop) &&
        hosts(idx, servicePattern, destStop) &&
        servicePattern !== pattern
      )
        continue;
      consider(pattern, service.destination);
    }
  }
  if (best.end > start) return best;
  // No matching published service: retain the geometric fallback for networks
  // whose timetables do not name destinations or full branch routings.
  for (const pattern of hosting) {
    const order = idx.patternStops.get(pattern)!;
    const next = indexOf(idx, pattern, stops[start + 1]!);
    const forward = next > indexOf(idx, pattern, fromStop);
    const endpoint = stationOf(idx, forward ? order.at(-1)! : order[0]!);
    if (endpoint) consider(pattern, endpoint);
  }
  return best.end > start ? best : { end: stops.length - 1 };
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

/** Prefer a known through train over zero-wait mixtures of sparse rail services. */
function preferThroughService(idx: NetworkIndex, leg: RouteLeg): RouteLeg {
  const lineId = leg.line_id;
  if (!lineId || !idx.throughServiceLines.has(lineId)) return leg;
  const published = idx.services.get(KEY_SERVICE(lineId, leg.from_station_id)) ?? [];
  let chosen: RouteLeg | undefined;
  for (const pattern of idx.patternsByLine.get(lineId) ?? []) {
    const from = indexOf(idx, pattern, leg.from_stop_id);
    const to = indexOf(idx, pattern, leg.to_stop_id);
    if (from < 0 || to < 0 || from === to) continue;
    const direction = Math.sign(to - from);
    if (
      !published.some((service) => {
        if (service.pattern_id !== pattern) return false;
        const destination = lineStopOf(idx, lineId, service.destination);
        if (!destination) return false;
        const headsign = indexOf(idx, pattern, destination);
        return headsign >= 0 && (headsign - to) * direction >= 0;
      })
    )
      continue;
    const order = idx.patternStops.get(pattern)!;
    const path = direction > 0 ? order.slice(from, to + 1) : order.slice(to, from + 1).reverse();
    if (path.some((stop) => !idx.operatingStops.has(stop))) continue;
    const weights = path
      .slice(1)
      .map((stop, i) => idx.segmentSeconds.get(KEY_SEGMENT(lineId, path[i]!, stop)));
    if (weights.some((seconds) => seconds == null || !Number.isFinite(seconds) || seconds <= 0))
      continue;
    const seconds = weights.reduce<number>((total, value) => total + value!, 0);
    if (chosen && chosen.seconds <= seconds) continue;
    chosen = { ...leg, seconds, station_ids: path.map((stop) => stationOf(idx, stop)!) };
  }
  return chosen ?? leg;
}

/** Split one ride leg where its boarding service cannot carry it, then annotate. */
function processRideLeg(idx: NetworkIndex, leg: RouteLeg): EnrichedLeg[] {
  const lineId = leg.line_id;
  if (!lineId || idx.loopLines.has(lineId)) {
    return [annotateRide(idx, leg, interiorPattern(idx, lineId ?? '', leg), undefined)];
  }

  const stops = stopSequence(idx, leg);
  if (stops.length < 2) {
    return [annotateRide(idx, leg, interiorPattern(idx, lineId, leg), undefined)];
  }

  const out: EnrichedLeg[] = [];
  let start = 0;
  while (start < stops.length - 1) {
    const first = resolveService(idx, lineId, stops, start);
    const end = first.end;
    const currentHeadsign = first.headsign_station_id;

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
  let totalSeconds = plan.total_seconds;
  for (const leg of plan.legs) {
    if (leg.kind === 'ride') {
      const ride = preferThroughService(idx, leg);
      totalSeconds += ride.seconds - leg.seconds;
      legs.push(...processRideLeg(idx, ride));
    } else {
      legs.push(leg);
    }
  }
  // Re-count: junction direction changes add same-station transfer legs.
  const transfers = legs.reduce((n, leg) => n + (leg.kind === 'transfer' ? 1 : 0), 0);
  return { ...plan, total_seconds: totalSeconds, legs, transfers };
}
