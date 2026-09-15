import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { createApiApp } from '../src/api/app.js';
import { type EnrichedRoutePlan, enrichRoutePlan } from '../src/api/headsigns.js';
import { createFsNetworkSource } from '../src/data/fs.js';
import { loadNetwork } from '../src/data/loader.js';
import { buildStopGraph } from '../src/graph/build.js';
import { planRoute } from '../src/graph/route.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, '../../../data');

async function planFor(network: string, from: string, to: string): Promise<EnrichedRoutePlan> {
  const d = await Effect.runPromise(loadNetwork(dataRoot, network));
  const graph = buildStopGraph(
    d.network.id,
    d.stops,
    d.segments,
    d.transfers,
    d.network.routing,
    'time'
  );
  const plan = planRoute(graph, d.stops, from, to);
  assert.ok(plan, `expected a route from ${from} to ${to}`);
  return enrichRoutePlan(d, plan);
}

function rides(plan: EnrichedRoutePlan) {
  return plan.legs.filter((l) => l.kind === 'ride' && 'headsign_station_id' in l) as Array<
    Extract<EnrichedRoutePlan['legs'][number], { kind: 'ride' }> & { headsign_station_id: string }
  >;
}

test('GZ3 airport branch: a forward leg carries the airport headsign', async () => {
  const plan = await planFor('cn-gz', 'cn-gz-tiyu-xilu', 'cn-gz-airport-n-t2');
  const ride = rides(plan);
  assert.equal(ride.length, 1);
  assert.equal(ride[0].headsign_station_id, 'cn-gz-airport-n-t2');
  assert.equal(ride[0].headsign_names?.en, 'Airport N.(T2)');
  assert.ok(ride[0].headsign_names?.zh);
  assert.ok(ride[0].pattern_id?.includes('line-3-pattern-0031'), 'should ride the branch pattern');
});

test('GZ3 reverse leg headsign is the far end, not the airport', async () => {
  const plan = await planFor('cn-gz', 'cn-gz-airport-n-t2', 'cn-gz-tiyu-xilu');
  const ride = rides(plan);
  assert.equal(ride.length, 1);
  assert.equal(ride[0].headsign_station_id, 'cn-gz-tiyu-xilu');
});

test('GZ3 through-junction leg splits at the published service terminal', async () => {
  const plan = await planFor('cn-gz', 'cn-gz-airport-n-t2', 'cn-gz-datang');
  // Airport branch service terminates at Tiyu Xilu in the published data, so
  // the through-ride must split there: ride -> same-station direction change
  // -> ride (now on the trunk service toward the south).
  assert.equal(plan.legs.length, 3);
  const [first, transfer, second] = plan.legs;
  assert.equal(first.kind, 'ride');
  assert.equal(first.to_station_id, 'cn-gz-tiyu-xilu');
  assert.equal((first as { headsign_station_id?: string }).headsign_station_id, 'cn-gz-tiyu-xilu');
  assert.equal(transfer.kind, 'transfer');
  assert.equal(transfer.from_stop_id, transfer.to_stop_id);
  assert.equal(transfer.from_station_id, 'cn-gz-tiyu-xilu');
  assert.equal(
    (transfer as { same_line_direction_change?: boolean }).same_line_direction_change,
    true
  );
  assert.equal(second.kind, 'ride');
  assert.equal(second.from_station_id, 'cn-gz-tiyu-xilu');
  assert.equal(second.to_station_id, 'cn-gz-datang');
  assert.equal((second as { headsign_station_id?: string }).headsign_station_id, 'cn-gz-haibang');
  assert.equal(plan.transfers, 1);
});

test('SH11 花桥 -> 嘉定北 splits at 嘉定新城 (no phantom through-ride)', async () => {
  const plan = await planFor('cn-sh', 'cn-sh-huaqiao', 'cn-sh-north-jiading');
  // Real operations: ride a 迪士尼-bound train to 嘉定新城, then a 嘉定北-bound
  // train from there. The old planner fabricated one continuous L11 ride.
  assert.equal(plan.legs.length, 3);
  const [first, transfer, second] = plan.legs;
  assert.equal(first.kind, 'ride');
  assert.equal((first as { to_station_id: string }).to_station_id, 'cn-sh-jiading-xincheng');
  assert.equal(
    (first as { headsign_station_id?: string }).headsign_station_id,
    'cn-sh-disney-resort'
  );
  assert.equal(transfer.kind, 'transfer');
  assert.equal(
    (transfer as { same_line_direction_change?: boolean }).same_line_direction_change,
    true
  );
  assert.equal((transfer as { line_id?: string }).line_id, 'cn-sh-line-11');
  assert.equal(second.kind, 'ride');
  assert.equal((second as { from_station_id: string }).from_station_id, 'cn-sh-jiading-xincheng');
  assert.equal(
    (second as { headsign_station_id?: string }).headsign_station_id,
    'cn-sh-north-jiading'
  );
  assert.equal(plan.transfers, 1);
  // Leg seconds still reconcile with the total.
  const sum = plan.legs.reduce((n, l) => n + l.seconds, 0);
  assert.equal(sum, plan.total_seconds, 'split legs must still sum to the route total');
});

test('SH11 shared trunk keeps a single leg with the common headsign', async () => {
  const plan = await planFor('cn-sh', 'cn-sh-jiading-xincheng', 'cn-sh-disney-resort');
  const ride = rides(plan);
  assert.equal(ride.length, 1);
  assert.equal(plan.transfers, 0);
  assert.equal(ride[0].headsign_station_id, 'cn-sh-disney-resort');
  // Both patterns cover the trunk; the primary one is reported.
  assert.equal(ride[0].pattern_id, 'cn-sh-line-11-pattern-main');
});

test('loop-line ride legs carry no headsign and do not split', async () => {
  // Shanghai Line 4 is a loop: find an OD the planner rides on it.
  const d = await Effect.runPromise(loadNetwork(dataRoot, 'cn-sh'));
  const graph = buildStopGraph(
    d.network.id,
    d.stops,
    d.segments,
    d.transfers,
    d.network.routing,
    'time'
  );
  const candidates: Array<[string, string]> = [
    ['cn-sh-zhongshan-park', 'cn-sh-hailun-road'],
    ['cn-sh-zhongshan-park', 'cn-sh-caoyang-road'],
    ['cn-sh-jinshajiang-road', 'cn-sh-damuqiao-road']
  ];
  for (const [from, to] of candidates) {
    const plan = planRoute(graph, d.stops, from, to);
    if (!plan) continue;
    const enriched = enrichRoutePlan(d, plan);
    const loopRides = enriched.legs.filter(
      (l) => l.kind === 'ride' && l.line_id === 'cn-sh-line-4'
    ) as Array<Record<string, unknown> & { kind: 'ride' }>;
    if (loopRides.length === 0) continue;
    for (const leg of loopRides) {
      assert.equal(leg.headsign_station_id, undefined, 'loop legs must not carry a headsign');
    }
    // No direction-change transfers may be invented on a loop.
    assert.ok(
      enriched.legs.every((l) => l.kind !== 'transfer' || !('same_line_direction_change' in l))
    );
    return;
  }
  assert.fail('no sampled Line 4 ride leg found — topology assumption broke');
});

test('decoded network carries the latest generated_at stamp', async () => {
  const sh = await Effect.runPromise(loadNetwork(dataRoot, 'cn-sh'));
  const raw = async (f: string): Promise<{ generated_at?: string }> =>
    JSON.parse(await Bun.file(join(dataRoot, `cn-sh/${f}`)).text()) as { generated_at?: string };
  const stamps = (
    await Promise.all([
      raw('lines.json'),
      raw('stations.json'),
      raw('timetables.json'),
      raw('segments.json')
    ])
  )
    .map((w) => w.generated_at)
    .filter((s): s is string => s != null);
  assert.ok(stamps.length >= 3);
  const latest = stamps.reduce((a: string, b: string) => (a > b ? a : b));
  assert.equal(sh.generated_at, latest);
  for (const s of stamps) assert.ok(sh.generated_at >= s, 'stamp must be the max across files');
});

test('API surface: /route legs expose headsigns and the split; network detail carries synced_at', {
  timeout: 30_000
}, async () => {
  const app = createApiApp(createFsNetworkSource(dataRoot));

  const route = await app.handle(
    new Request(
      'http://localhost/api/networks/cn-sh/route?from=cn-sh-huaqiao&to=cn-sh-north-jiading'
    )
  );
  assert.equal(route.status, 200);
  const body = (await route.json()) as {
    legs: Array<Record<string, unknown> & { kind: string }>;
    transfers: number;
  };
  assert.equal(body.transfers, 1);
  assert.equal(body.legs.length, 3);
  assert.equal(body.legs[0].headsign_station_id, 'cn-sh-disney-resort');
  assert.equal(body.legs[1].same_line_direction_change, true);
  assert.equal(body.legs[2].headsign_station_id, 'cn-sh-north-jiading');

  for (const network of ['cn-bj', 'cn-sh', 'cn-gz']) {
    const net = await app.handle(new Request(`http://localhost/api/networks/${network}`));
    assert.equal(net.status, 200, network);
    const meta = (await net.json()) as { synced_at?: unknown; generated_at?: unknown };
    assert.equal(typeof meta.synced_at, 'string', `${network} missing synced_at`);
    assert.equal(meta.generated_at, undefined, `${network} must not expose generated_at`);
  }

  const list = await app.handle(new Request('http://localhost/api/networks'));
  const listBody = (await list.json()) as { networks: Array<{ synced_at?: unknown }> };
  assert.ok(listBody.networks.length >= 1);
  assert.ok(listBody.networks.every((n) => n.synced_at === undefined));
});
