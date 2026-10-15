import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { buildStopGraph, loadNetwork, planRoute } from '@openmetro/core';
import { Effect } from 'effect';

test('shipped network routes every station in both directions, including inter-system transfers', async () => {
  const data = await Effect.runPromise(
    loadNetwork(resolve(import.meta.dir, '../../../../data'), 'cn-kaohsiung')
  );
  const graph = buildStopGraph(
    data.network.id,
    data.stops,
    data.segments,
    data.transfers,
    data.network.routing
  );
  for (const station of data.stations) {
    expect(planRoute(graph, data.stops, 'cn-kaohsiung-r3', station.id)).not.toBeNull();
    expect(planRoute(graph, data.stops, station.id, 'cn-kaohsiung-r3')).not.toBeNull();
  }
  const loop = planRoute(graph, data.stops, 'cn-kaohsiung-c37', 'cn-kaohsiung-c1');
  expect(loop?.transfers).toBe(0);
  expect(loop?.total_seconds).toBe(120);
  const interchange = planRoute(graph, data.stops, 'cn-kaohsiung-c24', 'cn-kaohsiung-r13');
  expect(interchange?.transfers).toBe(1);
});
