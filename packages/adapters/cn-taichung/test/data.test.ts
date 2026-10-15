import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { buildStopGraph, loadNetwork, planRoute } from '@openmetro/core';
import { Effect } from 'effect';

test('shipped routes include intermediate dwell and agree with official whole journeys', async () => {
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
    150
  );
  expect(planRoute(graph, data.stops, 'cn-taichung-103', 'cn-taichung-103a')?.total_seconds).toBe(
    150
  );
  for (const [from, to] of [
    ['cn-taichung-103a', 'cn-taichung-119'],
    ['cn-taichung-119', 'cn-taichung-103a']
  ])
    expect(planRoute(graph, data.stops, from!, to!)?.total_seconds).toBe(2130);
  const songzhu = data.timetables.find(
    (t) => t.station_id === 'cn-taichung-104' && t.destination_stop_id === 'cn-taichung-103a-g'
  );
  expect(songzhu?.first_train[0]).toBe('06:02');
  expect(songzhu?.last_train[0]).toBe('24:45');
});
