import type { StopGraph } from './build.js';

export interface RouteResult {
  from: string;
  to: string;
  totalWeight: number;
  path: string[];
}

/**
 * Multi-source, multi-target Dijkstra over the stop graph.
 *
 * Every node in `sources` starts at distance 0; the search stops as soon as any
 * node in `targets` is settled. This is what station-to-station routing needs:
 * a station maps to several stops (one per line), and the cheapest boarding /
 * alighting choice is part of the route.
 */
export function dijkstraMany(
  graph: StopGraph,
  sources: Iterable<string>,
  targets: Iterable<string>
): RouteResult | null {
  const targetSet = new Set(targets);
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const s of sources) {
    if (dist.has(s)) continue;
    dist.set(s, 0);
    queue.push(s);
  }
  if (queue.length === 0 || targetSet.size === 0) return null;

  let settled: string | undefined;
  while (queue.length > 0) {
    let u = queue[0];
    let uIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (dist.get(queue[i])! < dist.get(u)!) {
        u = queue[i];
        uIdx = i;
      }
    }
    queue.splice(uIdx, 1);
    if (visited.has(u)) continue;
    visited.add(u);
    if (targetSet.has(u)) {
      settled = u;
      break;
    }

    for (const { to: v, weight } of graph.adjacency.get(u) ?? []) {
      if (visited.has(v)) continue;
      const alt = dist.get(u)! + weight;
      const existing = dist.get(v);
      if (existing == null || alt < existing) {
        dist.set(v, alt);
        prev.set(v, u);
        queue.push(v);
      }
    }
  }

  if (settled == null) return null;

  const path: string[] = [];
  let cur: string | undefined = settled;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  const from = path[0];
  return { from, to: settled, totalWeight: dist.get(settled)!, path };
}

/** Single-source, single-target convenience over the stop graph. */
export function dijkstra(graph: StopGraph, from: string, to: string): RouteResult | null {
  return dijkstraMany(graph, [from], [to]);
}

/**
 * Single-source travel times to every reachable node. This is the primitive
 * behind an isochrone / travel-time query: run once from the origin's stops and
 * read off the seconds to each destination stop.
 */
export function travelTimes(graph: StopGraph, sources: Iterable<string>): Map<string, number> {
  const dist = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const s of sources) {
    if (dist.has(s)) continue;
    dist.set(s, 0);
    queue.push(s);
  }

  while (queue.length > 0) {
    let u = queue[0];
    let uIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (dist.get(queue[i])! < dist.get(u)!) {
        u = queue[i];
        uIdx = i;
      }
    }
    queue.splice(uIdx, 1);
    if (visited.has(u)) continue;
    visited.add(u);

    for (const { to: v, weight } of graph.adjacency.get(u) ?? []) {
      if (visited.has(v)) continue;
      const alt = dist.get(u)! + weight;
      const existing = dist.get(v);
      if (existing == null || alt < existing) {
        dist.set(v, alt);
        queue.push(v);
      }
    }
  }

  return dist;
}
