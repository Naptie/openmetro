import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { buildStopGraph, loadNetwork, planRoute } from '@openmetro/core';
import { Effect } from 'effect';

test('shipped data routes the entire line and preserves directional official seconds', async () => {
  const data = await Effect.runPromise(
    loadNetwork(resolve(import.meta.dir, '../../../../data'), 'cn-taichung')
  );
  const graph = buildStopGraph(
    data.network.id,
    data.stops,
    data.segments,
    data.transfers,
    data.network.routing
  );
  for (const station of data.stations) {
    expect(planRoute(graph, data.stops, 'cn-taichung-103a', station.id)).not.toBeNull();
    expect(planRoute(graph, data.stops, station.id, 'cn-taichung-103a')).not.toBeNull();
  }
  expect(planRoute(graph, data.stops, 'cn-taichung-103a', 'cn-taichung-103')?.total_seconds).toBe(
    124
  );
  expect(planRoute(graph, data.stops, 'cn-taichung-103', 'cn-taichung-103a')?.total_seconds).toBe(
    127
  );
});
