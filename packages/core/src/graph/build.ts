import type {
  SegmentEncoded as Segment,
  StopEncoded as Stop,
  TransferEncoded as Transfer,
} from "../schema/index.js";

/** Encoded (JSON) routing defaults, as read from `network.json`. */
export interface RoutingDefaultsInput {
  weight: WeightKind;
  default_transfer_seconds: number;
  max_transfer_seconds?: number;
}

/**
 * Routing weight. `time` (seconds) is the canonical default — it is always
 * available and is what real transit routers optimize. `distance` is a
 * secondary, best-effort weight: when a segment's distance is missing/zero,
 * the builder falls back to travel time so the graph stays connected.
 */
export type WeightKind = "time" | "distance";

/** A stop-level node. Line identity is what makes transfers explicit. */
export interface StopNode {
  id: string;
  station_id: string;
  line_id: string;
}

export interface StopEdge {
  from: string;
  to: string;
  kind: "ride" | "transfer";
  line_id?: string;
  seconds?: number;
  distance_km?: number;
  /** Resolved weight for the graph's `kind` (seconds or km), after fallback. */
  weight?: number;
}

export interface StopAdjacency {
  to: string;
  weight: number;
  kind: "ride" | "transfer";
  line_id?: string;
}

export interface StopGraph {
  networkId: string;
  kind: WeightKind;
  nodes: StopNode[];
  edges: StopEdge[];
  adjacency: Map<string, StopAdjacency[]>;
}

/** Station id -> the stops (line occurrences) that belong to it. */
export type StationIndex = Map<string, string[]>;

export function buildStationIndex(stops: Stop[]): StationIndex {
  const index: StationIndex = new Map();
  for (const stop of stops) {
    const list = index.get(stop.station_id) ?? [];
    list.push(stop.id);
    index.set(stop.station_id, list);
  }
  return index;
}

/**
 * Resolve the effective weight for an edge. `time` is the default and primary;
 * `distance` is best-effort. When the requested weight is missing/non-positive,
 * fall back to the alternate field so the graph stays connected and routing
 * never introduces a zero-cost phantom edge nor disconnects stations.
 */
function effectiveWeight(
  seconds: number | undefined,
  distanceKm: number | undefined,
  weightKind: WeightKind,
): number | undefined {
  const time = seconds != null && seconds > 0 ? seconds : undefined;
  const distance = distanceKm != null && distanceKm > 0 ? distanceKm : undefined;
  if (weightKind === "time") return time ?? distance;
  return distance ?? time;
}

/**
 * Build the routing graph at **stop level**: nodes are stops (a station's
 * presence on one line), ride edges connect consecutive stops, and transfer
 * edges connect a stop on one line to a stop on another line at the same
 * station. Keeping line identity on nodes is what allows transfer walk times
 * (or the network's default transfer penalty) to be charged correctly — a
 * station-collapsed graph cannot model this.
 *
 * `transfers` are directional records (line A -> line B at a station). When a
 * transfer's stop endpoints are omitted they are resolved from the stop table.
 * When its `walk_time_seconds` is unknown, `routing.default_transfer_seconds`
 * is used so the graph never gets a free or missing transfer.
 */
export function buildStopGraph(
  networkId: string,
  stops: Stop[],
  segments: Segment[],
  transfers: Transfer[],
  routing: RoutingDefaultsInput,
  weightKind: WeightKind = routing.weight,
): StopGraph {
  const nodes: StopNode[] = stops.map((s) => ({
    id: s.id,
    station_id: s.station_id,
    line_id: s.line_id,
  }));

  const stopByStationLine = new Map<string, string>();
  for (const stop of stops) stopByStationLine.set(`${stop.station_id}|${stop.line_id}`, stop.id);

  const resolveStop = (stationId: string, lineId: string, explicit?: string): string | undefined =>
    explicit ?? stopByStationLine.get(`${stationId}|${lineId}`);

  const edges: StopEdge[] = [];
  for (const seg of segments) {
    edges.push(
      withWeight(
        {
          from: seg.from_stop_id,
          to: seg.to_stop_id,
          kind: "ride",
          line_id: seg.line_id,
          seconds: seg.travel_time_seconds,
          distance_km: seg.distance_km,
        },
        weightKind,
      ),
    );
  }

  const defaultTransfer = routing.default_transfer_seconds;
  const maxTransfer = routing.max_transfer_seconds;
  const transferSeconds = (t: Transfer): number => {
    const raw = t.walk_time_seconds ?? defaultTransfer;
    return maxTransfer != null && raw > maxTransfer ? maxTransfer : raw;
  };

  for (const tr of transfers) {
    const from = resolveStop(tr.station_id, tr.from_line_id, tr.from_stop_id);
    const to = resolveStop(tr.station_id, tr.to_line_id, tr.to_stop_id);
    if (!from || !to || from === to) continue;
    edges.push(
      withWeight(
        {
          from,
          to,
          kind: "transfer",
          line_id: tr.to_line_id,
          seconds: transferSeconds(tr),
          distance_km: tr.walk_distance_meters != null ? tr.walk_distance_meters / 1000 : undefined,
        },
        weightKind,
      ),
    );
  }

  const adjacency = new Map<string, StopAdjacency[]>();
  const addAdj = (edge: StopEdge) => {
    if (edge.weight == null || edge.weight <= 0) return;
    const list = adjacency.get(edge.from) ?? [];
    list.push({ to: edge.to, weight: edge.weight, kind: edge.kind, line_id: edge.line_id });
    adjacency.set(edge.from, list);
  };

  for (const seg of segments) {
    const edge = withWeight(
      {
        from: seg.from_stop_id,
        to: seg.to_stop_id,
        kind: "ride",
        line_id: seg.line_id,
        seconds: seg.travel_time_seconds,
        distance_km: seg.distance_km,
      },
      weightKind,
    );
    // `from`/`to` follow the pattern order. Honor `direction` so a "both"
    // segment is traversable in either direction.
    if (seg.direction !== "backward") addAdj(edge);
    if (seg.direction !== "forward") addAdj({ ...edge, from: edge.to, to: edge.from });
  }
  for (const edge of edges) {
    if (edge.kind === "transfer") addAdj(edge);
  }

  return { networkId, kind: weightKind, nodes, edges, adjacency };
}

function withWeight(edge: StopEdge, weightKind: WeightKind): StopEdge {
  return {
    ...edge,
    weight: effectiveWeight(edge.seconds, edge.distance_km, weightKind),
  };
}
