import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { createApiApp } from '../src/api/app.js';
import { createFsNetworkSource } from '../src/data/fs.js';
import { loadNetwork, type NetworkData } from '../src/data/loader.js';
import { buildStopGraph, type WeightKind } from '../src/graph/build.js';
import { travelTimes } from '../src/graph/dijkstra.js';
import { planRoute } from '../src/graph/route.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, '../../../data');

const BEIJING = 'cn-beijing';
const SHANGHAI = 'cn-shanghai';
const GUANGZHOU = 'cn-guangzhou';

function graphFor(d: NetworkData, weight: WeightKind = 'time') {
  return buildStopGraph(d.network.id, d.stops, d.segments, d.transfers, d.network.routing, weight);
}

async function load(id: string): Promise<NetworkData> {
  return Effect.runPromise(loadNetwork(dataRoot, id));
}

test('Beijing routes by time across a transfer', async () => {
  const d = await load(BEIJING);
  assert.ok(d.lines.length > 0);
  assert.ok(d.stations.length > 0);
  const plan = planRoute(graphFor(d), d.stops, 'cn-beijing-pingguoyuan', 'cn-beijing-xizhimen');
  assert.ok(plan);
  assert.ok(plan.total_seconds > 0);
  assert.ok(plan.legs.length >= 1);
});

test('Beijing distance stays connected via time fallback', async () => {
  const d = await load(BEIJING);
  const plan = planRoute(
    graphFor(d, 'distance'),
    d.stops,
    'cn-beijing-pingguoyuan',
    'cn-beijing-xizhimen'
  );
  assert.ok(plan);
  assert.ok(plan.total_seconds > 0);
});

test('Shanghai routes by time', async () => {
  const d = await load(SHANGHAI);
  assert.ok(d.lines.length > 0);
  assert.ok(d.stations.length > 0);
  const plan = planRoute(
    graphFor(d),
    d.stops,
    'cn-shanghai-xinzhuang',
    'cn-shanghai-people-s-square'
  );
  assert.ok(plan, 'expected a Shanghai route');
  assert.ok(plan.total_seconds > 0);
});

test('Guangzhou routes by time', async () => {
  const d = await load(GUANGZHOU);
  assert.ok(d.lines.length > 0);
  assert.ok(d.stations.length > 0);
  const plan = planRoute(
    graphFor(d),
    d.stops,
    'cn-guangzhou-tiyu-xilu',
    'cn-guangzhou-guangzhou-south-railway-station'
  );
  assert.ok(plan, 'expected a Guangzhou route');
  assert.ok(plan.total_seconds > 0);
});

test('all networks have transfers and segment travel times', async () => {
  for (const id of [BEIJING, SHANGHAI, GUANGZHOU]) {
    const d = await load(id);
    assert.ok(d.transfers.length > 0, `${id} should have transfer edges`);
    assert.ok(d.timetables.length > 0, `${id} should have timetables`);
    const withTime = d.segments.filter((s) => s.travel_time_seconds != null);
    assert.ok(withTime.length > 0, `${id} should have segment travel times`);
    const ids = new Set(d.timetables.map((t) => t.id));
    assert.equal(ids.size, d.timetables.length, `${id} timetable ids must be unique`);
  }
});

test('Beijing transfers carry official walk times where the legend resolves', async () => {
  const d = await load(BEIJING);
  const official = d.transfers.filter((t) => t.walk_time_seconds != null);
  assert.ok(official.length > 0, 'expected official Beijing transfer times');
});

test('Beijing keeps source segment times', async () => {
  const d = await load(BEIJING);
  const src = d.segments.filter((s) => s.travel_time_source === 'source');
  assert.ok(src.length > 0);
});

test('Guangzhou derives segment times from last train', async () => {
  const d = await load(GUANGZHOU);
  const derived = d.segments.filter((s) => s.travel_time_source === 'last_train');
  assert.ok(derived.length > 0, `${GUANGZHOU} should have derived segment times`);
});

test('Shanghai segments use planner or last-train times', async () => {
  const d = await load(SHANGHAI);
  const timed = d.segments.filter(
    (s) => s.travel_time_source === 'planner' || s.travel_time_source === 'last_train'
  );
  assert.ok(timed.length > 0, `${SHANGHAI} should have planner/last_train segment times`);
});

test('Shanghai transfers carry official walk times', async () => {
  const d = await load(SHANGHAI);
  const timed = d.transfers.filter((t) => t.walk_time_seconds != null);
  assert.ok(timed.length > 0, 'expected harvested Shanghai transfer times');
});

test('every network has route patterns with consistent references', async () => {
  for (const id of [BEIJING, SHANGHAI, GUANGZHOU]) {
    const d = await load(id);
    assert.ok(d.patterns.length > 0, `${id} should have patterns`);
    const stopIds = new Set(d.stops.map((s) => s.id));
    for (const p of d.patterns) {
      assert.ok(p.stop_ids.length >= 2, `${p.id} needs at least 2 stops`);
      assert.equal(p.origin_stop_id, p.stop_ids[0]);
      assert.equal(p.terminal_stop_id, p.stop_ids[p.stop_ids.length - 1]);
      for (const stopId of p.stop_ids) {
        assert.ok(stopIds.has(stopId), `${p.id} references unknown stop ${stopId}`);
      }
    }
    const linesWithStops = new Set(d.stops.map((s) => s.line_id));
    const linesWithPatterns = new Set(d.patterns.map((p) => p.line_id));
    for (const lineId of linesWithStops) {
      assert.ok(linesWithPatterns.has(lineId), `${lineId} has stops but no pattern`);
    }
  }
});

test('Shanghai Line 11 branch topology is correct', async () => {
  const d = await load(SHANGHAI);
  const pairs = new Set(d.segments.map((s) => `${s.from_stop_id}|${s.to_stop_id}`));
  // Both branches meet the junction at Jiading Xincheng.
  assert.ok(pairs.has('cn-shanghai-shanghai-circuit-11|cn-shanghai-jiading-xincheng-11'));
  assert.ok(pairs.has('cn-shanghai-baiyin-road-11|cn-shanghai-jiading-xincheng-11'));
  // The old flat-sequence phantom bridge must be gone.
  assert.ok(!pairs.has('cn-shanghai-shanghai-circuit-11|cn-shanghai-north-jiading-11'));
  // Jiading Xincheng is a junction: three distinct neighbours on Line 11.
  const neighbours = d.segments
    .filter((s) => s.line_id === 'cn-shanghai-line-11')
    .flatMap((s) =>
      s.from_stop_id === 'cn-shanghai-jiading-xincheng-11'
        ? [s.to_stop_id]
        : s.to_stop_id === 'cn-shanghai-jiading-xincheng-11'
          ? [s.from_stop_id]
          : []
    );
  assert.equal(new Set(neighbours).size, 3);
  // Timetables identify a destination, not a forward/backward axis.
  const line11 = d.timetables.filter((t) => t.line_id === 'cn-shanghai-line-11');
  assert.ok(line11.length > 0);
  assert.ok(line11.every((t) => t.destination_stop_id != null));
});

test('Shanghai Line 11 branch is routable in both directions via the junction', async () => {
  const d = await load(SHANGHAI);
  const g = graphFor(d);
  const out = planRoute(g, d.stops, 'cn-shanghai-huaqiao', 'cn-shanghai-north-jiading');
  assert.ok(out, 'Huaqiao -> North Jiading should route');
  assert.ok(
    out.legs.some((l) => l.station_ids?.includes('cn-shanghai-jiading-xincheng')),
    'must pass the junction'
  );
  const back = planRoute(g, d.stops, 'cn-shanghai-north-jiading', 'cn-shanghai-huaqiao');
  assert.ok(back, 'North Jiading -> Huaqiao should route (reverse segments)');
});

test('Guangzhou Line 3 branch topology is correct', async () => {
  const d = await load(GUANGZHOU);
  const junction = 'cn-guangzhou-tiyu-xilu-cn-guangzhou-line-3';
  const neighbours = d.segments
    .filter((s) => s.line_id === 'cn-guangzhou-line-3')
    .flatMap((s) =>
      s.from_stop_id === junction
        ? [s.to_stop_id]
        : s.to_stop_id === junction
          ? [s.from_stop_id]
          : []
    );
  assert.equal(new Set(neighbours).size, 3);
  const branch = d.patterns.find((p) => p.line_id === 'cn-guangzhou-line-3' && !p.is_primary);
  assert.ok(branch);
  assert.equal(branch.junction_stop_id, junction);
});

test('travel-times isochrone reaches known stations', async () => {
  const d = await load(BEIJING);
  const g = graphFor(d);
  const sources = d.stops.filter((s) => s.station_id === 'cn-beijing-pingguoyuan').map((s) => s.id);
  const times = travelTimes(g, sources);
  const atGucheng = d.stops.find((s) => s.station_id === 'cn-beijing-gucheng');
  assert.ok(atGucheng);
  assert.ok((times.get(atGucheng.id) ?? Infinity) > 0);
});

test('projected lines carry short_name on the wire', { timeout: 30_000 }, async () => {
  const app = createApiApp(createFsNetworkSource(dataRoot));
  const shortNamesOf = async (network: string) => {
    const res = await app.handle(new Request(`http://localhost/api/networks/${network}/lines`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string }[];
    assert.ok(body.length > 0);
    // `short_name` is mandatory on every line — the key must exist and be a
    // non-empty string.
    for (const line of body) {
      assert.ok('short_name' in line, `line ${line.id} is missing the short_name key`);
      const shortName = (line as { short_name: unknown }).short_name;
      assert.equal(typeof shortName, 'string', `line ${line.id} short_name is not a string`);
      assert.ok((shortName as string).length > 0, `line ${line.id} short_name is empty`);
    }
    return new Map(body.map((l) => [l.id, (l as { short_name: string }).short_name]));
  };

  const gz = await shortNamesOf(GUANGZHOU);
  assert.equal(gz.get('cn-guangzhou-line-apm'), 'APM');
  assert.equal(gz.get('cn-guangzhou-line-1'), '1');
  assert.equal(gz.get('cn-guangzhou-line-guangzhou-huizhou-intercity'), '广惠');

  const bj = await shortNamesOf(BEIJING);
  assert.equal(bj.get('cn-beijing-line-1'), '1');
  assert.equal(bj.get('cn-beijing-line-73'), '18'); // 18号线: lnub (73) is an internal id
  assert.equal(bj.get('cn-beijing-line-79'), '亦庄T1'); // 亦庄T1线: official slb label
  assert.equal(bj.get('cn-beijing-line-91'), 'S1'); // S1线: official slb label
  assert.equal(bj.get('cn-beijing-line-88'), '大兴机场'); // 大兴机场线: official slb label

  const sh = await shortNamesOf(SHANGHAI);
  assert.equal(sh.get('cn-shanghai-line-1'), '1');
  assert.equal(sh.get('cn-shanghai-line-41'), '浦江线'); // no numeric code → official name
  assert.equal(sh.get('cn-shanghai-line-51'), '市域机场线'); // no numeric code → official name
});
