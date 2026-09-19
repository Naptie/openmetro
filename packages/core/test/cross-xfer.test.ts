import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CROSS_XFER_RULES,
  deriveCrossStationTransfers,
  deriveTransfers,
  normalizeStationName
} from '../src/graph/transfers.js';

const routing = { default_transfer_seconds: 120, max_transfer_seconds: 600 };

function station(id: string, zh: string, lon: number, lat: number, locSource = 'official') {
  return {
    id,
    name: zh,
    names: { zh, en: zh },
    location: { lon, lat, crs: 'gcj02' as const },
    status: 'operating' as const,
    source_ids: [],
    extras: { location_source: locSource }
  } as any;
}

const lines = [
  { id: 'L7', mode: 'metro' },
  { id: 'GZIC', mode: 'suburban_rail' },
  { id: 'THP1', mode: 'tram' },
  { id: 'L14', mode: 'metro' }
];

const stations = [
  station('gz-chencun', '陈村', 113.236869, 22.967991, 'subway'),
  station('gz-chencun-ic', '陈村(城际)', 113.239612, 22.96952),
  station('gz-shuixi', '水西', 113.47878, 23.187489, 'subway'),
  station('gz-shuixi-tram', '地铁水西', 113.479306, 23.187017),
  station('gz-beijiao-metro', '北滘西站', 113.178142, 22.952097, 'subway'),
  station('gz-beijiao-ic', '北滘西', 113.178272, 22.952441),
  station('gz-airport-n', '机场北（T2）', 113.30514, 23.395529),
  station('gz-baiyun-airport-n', '白云机场北（T2）', 113.305964, 23.396928),
  station('gz-gzbei', '广州北站', 113.201568, 23.376419, 'subway'),
  station('gz-huadu', '花都', 113.201384, 23.377115),
  // same-line consecutive tram — must not get a cross edge
  station('gz-thz-a', '琶洲大桥南', 113.373699, 23.104265),
  station('gz-thz-b', '琶洲塔', 113.375622, 23.104232),
  // unnamed near metro pair — strict hub should skip
  station('gz-shixi', '石溪', 113.285951, 23.067937, 'subway'),
  station('gz-gongye', '工业大道南', 113.288847, 23.067856, 'subway')
];

const stops = [
  { id: 'gz-chencun-L7', station_id: 'gz-chencun', line_id: 'L7' },
  { id: 'gz-chencun-ic-GZIC', station_id: 'gz-chencun-ic', line_id: 'GZIC' },
  { id: 'gz-shuixi-L21', station_id: 'gz-shuixi', line_id: 'L14' },
  { id: 'gz-shuixi-tram-THP1', station_id: 'gz-shuixi-tram', line_id: 'THP1' },
  { id: 'gz-beijiao-metro-F3', station_id: 'gz-beijiao-metro', line_id: 'L14' },
  { id: 'gz-beijiao-ic-GZIC', station_id: 'gz-beijiao-ic', line_id: 'GZIC' },
  { id: 'gz-airport-n-L3', station_id: 'gz-airport-n', line_id: 'L14' },
  { id: 'gz-baiyun-airport-n-GZIC', station_id: 'gz-baiyun-airport-n', line_id: 'GZIC' },
  { id: 'gz-gzbei-L9', station_id: 'gz-gzbei', line_id: 'L14' },
  { id: 'gz-huadu-GZIC', station_id: 'gz-huadu', line_id: 'GZIC' },
  { id: 'gz-thz-a-THZ', station_id: 'gz-thz-a', line_id: 'THP1' },
  { id: 'gz-thz-b-THZ', station_id: 'gz-thz-b', line_id: 'THP1' },
  { id: 'gz-shixi-GF', station_id: 'gz-shixi', line_id: 'GZIC' },
  { id: 'gz-gongye-L10', station_id: 'gz-gongye', line_id: 'L7' }
];

const patterns = [
  {
    id: 'thz',
    stop_ids: ['gz-thz-a-THZ', 'gz-thz-b-THZ']
  }
];

function hasPair(edges: any[], idA: string, idB: string): boolean {
  return edges.some(
    (e) =>
      String(e.source_id ?? '').startsWith('auto-xfer/v1') &&
      e.source_id.includes(idA) &&
      e.source_id.includes(idB)
  );
}

test('normalizeStationName classifies system and access tags', () => {
  const ic = normalizeStationName('a', '陈村(城际)');
  assert.equal(ic.exact, '陈村');
  assert.ok(ic.tags.has('system=intercity'));
  const metro = normalizeStationName('b', '地铁水西');
  assert.ok(metro.metroAccess);
  assert.equal(metro.exact, '水西');
  const hub = normalizeStationName('c', '北滘西站');
  assert.ok(hub.hasZhan);
  assert.equal(hub.bareNoZhan, '北滘西');
  const air = normalizeStationName('d', '白云机场北（T2）');
  assert.ok(air.airportKey?.includes('机场北'));
});

test('deriveCrossStationTransfers fires automatic rules for known complexes', () => {
  const edges = deriveCrossStationTransfers({
    stations,
    stops,
    patterns,
    lines,
    routing
  });
  const sourceOf = (a: string, b: string) => {
    const hit = edges.find(
      (e) => String(e.source_id).includes(a) && String(e.source_id).includes(b)
    );
    return hit;
  };

  const chencun = sourceOf('gz-chencun-ic', 'gz-chencun');
  assert.ok(chencun, 'chencun pair');
  assert.equal(chencun.extras?.rule, CROSS_XFER_RULES.NAME_EXACT);
  assert.equal(chencun.is_out_of_station, true);
  assert.ok((chencun.walk_time_seconds ?? 0) >= 120);
  assert.ok(String(chencun.source_id).startsWith('auto-xfer/v1/'));

  const shuixi = sourceOf('gz-shuixi-tram', 'gz-shuixi');
  assert.ok(shuixi, 'shuixi pair');
  assert.ok(
    [
      CROSS_XFER_RULES.NAME_METRO_ACCESS,
      CROSS_XFER_RULES.NAME_EXACT,
      CROSS_XFER_RULES.NAME_STA_SUFFIX
    ].includes(shuixi.extras?.rule),
    String(shuixi.extras)
  );

  const beijiao = sourceOf('gz-beijiao-metro', 'gz-beijiao-ic');
  assert.ok(beijiao?.extras?.rule === CROSS_XFER_RULES.NAME_STA_SUFFIX);

  const airport = sourceOf('gz-airport-n', 'gz-baiyun-airport-n');
  assert.ok(airport, 'airport pair');
  assert.ok(
    [
      CROSS_XFER_RULES.NAME_AIRPORT,
      CROSS_XFER_RULES.NAME_EXACT,
      CROSS_XFER_RULES.HUB_NEAR,
      CROSS_XFER_RULES.NAME_TOKEN
    ].includes(airport.extras?.rule),
    String(airport.extras)
  );

  const huadu = sourceOf('gz-gzbei', 'gz-huadu');
  assert.ok(huadu, 'guangzhou north / huadu');
  assert.ok(
    [CROSS_XFER_RULES.HUB_NEAR, CROSS_XFER_RULES.NAME_TOKEN].includes(huadu.extras?.rule),
    String(huadu.extras)
  );

  // Veto same-line consecutive tram stops
  assert.equal(hasPair(edges, 'gz-thz-a', 'gz-thz-b'), false);
  // strict hub skips unnamed metro pair
  assert.equal(hasPair(edges, 'gz-shixi', 'gz-gongye'), false);
});

test('deriveTransfers merges same-station and cross-station edges', () => {
  const same = stations.concat([
    station('gz-zhenlong', '镇龙', 113.593, 23.284514, 'subway'),
    station('gz-zhenlong-ic', '镇龙（城际）', 113.591202, 23.283865)
  ]);
  const allStops = stops.concat([
    { id: 'gz-zhenlong-L14', station_id: 'gz-zhenlong', line_id: 'L14' },
    { id: 'gz-zhenlong-L21', station_id: 'gz-zhenlong', line_id: 'L7' },
    { id: 'gz-zhenlong-ic-GZIC', station_id: 'gz-zhenlong-ic', line_id: 'GZIC' }
  ]);
  const merged = deriveTransfers(same, allStops, [], {
    patterns,
    lines,
    routing,
    crossStation: true
  });
  const sameStation = merged.filter(
    (t) => t.station_id === 'gz-zhenlong' && !t.source_id?.startsWith('auto')
  );
  assert.ok(sameStation.length >= 2, 'same-station line pair transfers');
  assert.ok(hasPair(merged, 'gz-zhenlong', 'gz-zhenlong-ic'));
  assert.ok(hasPair(merged, 'gz-chencun-ic', 'gz-chencun'));
});

test('deriveTransfers can disable cross-station derivation', () => {
  const onlySame = deriveTransfers(stations, stops, [], {
    patterns,
    lines,
    routing,
    crossStation: false
  });
  assert.equal(
    onlySame.filter((t) => String(t.source_id ?? '').startsWith('auto-xfer/v1')).length,
    0
  );
});
