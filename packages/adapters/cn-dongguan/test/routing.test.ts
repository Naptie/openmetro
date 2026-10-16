import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStopGraph, findRepoRoot, loadNetwork, planRoute } from '@openmetro/core';
import { Effect } from 'effect';

test('published Dongguan data routes across both lines via Civic Center in both directions', async () => {
  const d = await Effect.runPromise(
    loadNetwork(join(findRepoRoot(import.meta.dir), 'data'), 'cn-dongguan')
  );
  const graph = buildStopGraph(d.network.id, d.stops, d.segments, d.transfers, d.network.routing);
  const from = d.stations.find((s) => s.name === '东莞西站')!.id;
  const to = d.stations.find((s) => s.name === '虎门火车站')!.id;
  const interchange = d.stations.find((s) => s.name === '市民中心')!.id;
  for (const [a, b] of [
    [from, to],
    [to, from]
  ]) {
    const plan = planRoute(graph, d.stops, a!, b!);
    expect(plan).not.toBeNull();
    expect(plan!.total_seconds).toBeGreaterThan(0);
    const changes = plan!.legs.filter((leg) => leg.kind === 'transfer');
    expect(changes.length).toBe(1);
    expect(changes[0]!.from_station_id).toBe(interchange);
    expect(changes[0]!.to_station_id).toBe(interchange);
  }
});
