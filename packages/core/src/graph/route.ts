import type { StopEncoded as Stop } from '../schema/index.js';
import type { StopGraph } from './build.js';
import { buildStationIndex, type StationIndex } from './build.js';
import { dijkstraMany } from './dijkstra.js';

export interface RouteLeg {
  kind: 'ride' | 'transfer';
  /** Line ridden / entered; absent only for a malformed transfer. */
  line_id?: string;
  from_stop_id: string;
  to_stop_id: string;
  from_station_id: string;
  to_station_id: string;
  seconds: number;
  /** Station ids visited in order (ride legs only; includes both endpoints). */
  station_ids?: string[];
}

export interface RoutePlan {
  from_station_id: string;
  to_station_id: string;
  total_seconds: number;
  transfers: number;
  legs: RouteLeg[];
}

interface EdgeLookup {
  kind: 'ride' | 'transfer';
  line_id?: string;
  weight: number;
}

function edgeBetween(graph: StopGraph, from: string, to: string): EdgeLookup | undefined {
  let best: EdgeLookup | undefined;
  for (const e of graph.adjacency.get(from) ?? []) {
    if (e.to !== to) continue;
    if (!best || e.weight < best.weight)
      best = { kind: e.kind, line_id: e.line_id, weight: e.weight };
  }
  return best;
}

/**
 * Plan a station-to-station journey over the stop graph and return it as
 * human-readable legs (consecutive rides on one line collapse into a single
 * ride leg; every line change is an explicit transfer leg).
 */
export function planRoute(
  graph: StopGraph,
  stops: Stop[],
  fromStationId: string,
  toStationId: string,
  stationIndex: StationIndex = buildStationIndex(stops)
): RoutePlan | null {
  const sources = stationIndex.get(fromStationId) ?? [];
  const targets = stationIndex.get(toStationId) ?? [];
  const result = dijkstraMany(graph, sources, targets);
  if (!result) return null;

  const stopById = new Map(stops.map((s) => [s.id, s]));
  const legs: RouteLeg[] = [];
  let transfers = 0;

  let current: RouteLeg | undefined;
  for (let i = 0; i < result.path.length - 1; i++) {
    const a = result.path[i];
    const b = result.path[i + 1];
    const edge = edgeBetween(graph, a, b);
    const aStop = stopById.get(a);
    const bStop = stopById.get(b);
    if (!edge || !aStop || !bStop) continue;

    if (edge.kind === 'ride' && current?.kind === 'ride' && current.line_id === edge.line_id) {
      current.to_stop_id = b;
      current.to_station_id = bStop.station_id;
      current.seconds += edge.weight;
      current.station_ids?.push(bStop.station_id);
      continue;
    }

    current = {
      kind: edge.kind,
      line_id: edge.line_id,
      from_stop_id: a,
      to_stop_id: b,
      from_station_id: aStop.station_id,
      to_station_id: bStop.station_id,
      seconds: edge.weight,
      ...(edge.kind === 'ride' ? { station_ids: [aStop.station_id, bStop.station_id] } : {})
    };
    legs.push(current);
    if (edge.kind === 'transfer') transfers++;
  }

  return {
    from_station_id: fromStationId,
    to_station_id: toStationId,
    total_seconds: result.totalWeight,
    transfers,
    legs
  };
}
