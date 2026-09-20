import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStationIndex, buildStopGraph } from '../src/graph/build.js';
import { dijkstra, travelTimes } from '../src/graph/dijkstra.js';
import { planRoute } from '../src/graph/route.js';

const routing = { weight: 'time' as const, default_transfer_seconds: 120 };

const stops = [
  { id: 'cn-beijing-a-l1', station_id: 'cn-beijing-a', line_id: 'cn-beijing-l1', sequence: 0 },
  { id: 'cn-beijing-b-l1', station_id: 'cn-beijing-b', line_id: 'cn-beijing-l1', sequence: 1 },
  { id: 'cn-beijing-c-l1', station_id: 'cn-beijing-c', line_id: 'cn-beijing-l1', sequence: 2 },
  { id: 'cn-beijing-b-l2', station_id: 'cn-beijing-b', line_id: 'cn-beijing-l2', sequence: 0 },
  { id: 'cn-beijing-c-l2', station_id: 'cn-beijing-c', line_id: 'cn-beijing-l2', sequence: 1 }
] as any;

const segments = [
  {
    id: 's1',
    line_id: 'cn-beijing-l1',
    from_stop_id: 'cn-beijing-a-l1',
    to_stop_id: 'cn-beijing-b-l1',
    from_station_id: 'cn-beijing-a',
    to_station_id: 'cn-beijing-b',
    direction: 'both',
    travel_time_seconds: 100,
    distance_km: 1.0
  },
  {
    id: 's2',
    line_id: 'cn-beijing-l1',
    from_stop_id: 'cn-beijing-b-l1',
    to_stop_id: 'cn-beijing-c-l1',
    from_station_id: 'cn-beijing-b',
    to_station_id: 'cn-beijing-c',
    direction: 'both',
    travel_time_seconds: 200,
    distance_km: 2.0
  },
  {
    id: 's3',
    line_id: 'cn-beijing-l2',
    from_stop_id: 'cn-beijing-b-l2',
    to_stop_id: 'cn-beijing-c-l2',
    from_station_id: 'cn-beijing-b',
    to_station_id: 'cn-beijing-c',
    direction: 'both',
    travel_time_seconds: 50,
    distance_km: 0.5
  }
] as any;

const transfers = [
  {
    id: 't1',
    station_id: 'cn-beijing-b',
    from_line_id: 'cn-beijing-l1',
    to_line_id: 'cn-beijing-l2',
    from_stop_id: 'cn-beijing-b-l1',
    to_stop_id: 'cn-beijing-b-l2',
    walk_time_seconds: 60
  },
  {
    id: 't2',
    station_id: 'cn-beijing-b',
    from_line_id: 'cn-beijing-l2',
    to_line_id: 'cn-beijing-l1',
    from_stop_id: 'cn-beijing-b-l2',
    to_stop_id: 'cn-beijing-b-l1',
    walk_time_seconds: 60
  }
] as any;

function graph() {
  return buildStopGraph('cn-beijing', stops, segments, transfers, routing, 'time');
}

test('buildStopGraph keeps line identity on nodes and edges', () => {
  const g = graph();
  assert.equal(g.nodes.length, 5);
  assert.equal(g.edges.filter((e) => e.kind === 'ride').length, 3);
  assert.equal(g.edges.filter((e) => e.kind === 'transfer').length, 2);
});

test('stop graph charges the transfer walk time', () => {
  const g = graph();
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l2');
  assert.ok(r);
  // a -> b (100) -> transfer (60) -> c on l2 (50) = 210, cheaper than 300 on l1.
  assert.equal(r.totalWeight, 210);
});

test('missing transfer time falls back to the network default', () => {
  const noTime = [
    { ...transfers[0], walk_time_seconds: undefined },
    { ...transfers[1], walk_time_seconds: undefined }
  ] as any;
  const g = buildStopGraph('cn-beijing', stops, segments, noTime, routing, 'time');
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l2');
  assert.ok(r);
  assert.equal(r.totalWeight, 100 + 120 + 50);
});

test('dijkstra routes in both directions on bidirectional segments', () => {
  const g = graph();
  const r = dijkstra(g, 'cn-beijing-c-l1', 'cn-beijing-a-l1');
  assert.ok(r);
  assert.equal(r.totalWeight, 300);
});

test('planRoute collapses a ride and exposes transfers as legs', () => {
  const g = graph();
  const plan = planRoute(g, stops, 'cn-beijing-a', 'cn-beijing-c');
  assert.ok(plan);
  assert.equal(plan.total_seconds, 210);
  assert.equal(plan.transfers, 1);
  assert.deepEqual(
    plan.legs.map((l) => l.kind),
    ['ride', 'transfer', 'ride']
  );
  assert.equal(plan.legs[0].line_id, 'cn-beijing-l1');
  assert.equal(plan.legs[2].line_id, 'cn-beijing-l2');
});

test('travelTimes returns seconds to every reachable stop', () => {
  const g = graph();
  const times = travelTimes(g, ['cn-beijing-a-l1']);
  assert.equal(times.get('cn-beijing-a-l1'), 0);
  assert.equal(times.get('cn-beijing-b-l1'), 100);
  assert.equal(times.get('cn-beijing-c-l2'), 210);
});

test('distance weight is best-effort and falls back to time', () => {
  const g = buildStopGraph('cn-beijing', stops, segments, transfers, routing, 'distance');
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l1');
  assert.ok(r);
  assert.equal(r.totalWeight, 3.0);
});

test('non-operating stations are excluded from the stop graph', () => {
  const stationStatuses = [
    { id: 'cn-beijing-a', status: 'operating' as const },
    { id: 'cn-beijing-b', status: 'out_of_service' as const },
    { id: 'cn-beijing-c', status: 'operating' as const }
  ];
  const g = buildStopGraph('cn-beijing', stops, segments, transfers, routing, 'time', {
    stations: stationStatuses
  });
  assert.deepEqual([...new Set(g.nodes.map((n) => n.station_id))].sort(), [
    'cn-beijing-a',
    'cn-beijing-c'
  ]);
  // b is offline: no ride through b, no transfer at b.
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l1');
  assert.equal(r, null);
  const index = buildStationIndex(stops, { stations: stationStatuses });
  assert.equal(index.has('cn-beijing-b'), false);
});

test('non-operating lines are excluded from the stop graph', () => {
  const g = buildStopGraph('cn-beijing', stops, segments, transfers, routing, 'time', {
    stations: [
      { id: 'cn-beijing-a', status: 'operating' as const },
      { id: 'cn-beijing-b', status: 'operating' as const },
      { id: 'cn-beijing-c', status: 'operating' as const }
    ],
    lines: [
      { id: 'cn-beijing-l1', status: 'operating' },
      { id: 'cn-beijing-l2', status: 'under_construction' }
    ]
  });
  assert.deepEqual([...new Set(g.nodes.map((n) => n.line_id))].sort(), ['cn-beijing-l1']);
  // Transfer onto the planned corridor is not offered.
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l2');
  assert.equal(r, null);
  const onLine = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l1');
  assert.ok(onLine);
});

test('through-running transfer with zero walk time stays traversable', () => {
  const xfers = [
    { ...transfers[0], walk_time_seconds: 0 },
    { ...transfers[1], walk_time_seconds: 0 }
  ] as any;
  const g = buildStopGraph('cn-beijing', stops, segments, xfers, routing, 'time');
  const r = dijkstra(g, 'cn-beijing-a-l1', 'cn-beijing-c-l2');
  assert.ok(r);
  assert.equal(r.totalWeight, 100 + 0 + 50);
});
