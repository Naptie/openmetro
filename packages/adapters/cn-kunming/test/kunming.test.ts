import { expect, test } from 'bun:test';

import { kunmingMileageFare } from '../src/fares.ts';
import { type AmapSubwayDoc, parsePlannerCoordPairs, parseServicePattern } from '../src/fetch.ts';
import { buildKunmingTopology, foldAmapStationName } from '../src/normalize.ts';
import { splitPolylineByStations } from '../src/times.ts';

test('distance ladder matches the published Kunming tariff', () => {
  // 里程分段计价票制：起步 2 元可乘 4 公里，之后每跳一档加 1 元，
  // 晋级里程 4/4/5/6/7/8/9/10 公里递增（「递远递减」＝每公里单价递减）。
  expect(kunmingMileageFare(0)).toBe(2);
  expect(kunmingMileageFare(1.2)).toBe(2);
  expect(kunmingMileageFare(4)).toBe(2);
  expect(kunmingMileageFare(4.01)).toBe(3);
  expect(kunmingMileageFare(8)).toBe(3);
  expect(kunmingMileageFare(8.01)).toBe(4);
  expect(kunmingMileageFare(13)).toBe(4);
  expect(kunmingMileageFare(13.01)).toBe(5);
  expect(kunmingMileageFare(19)).toBe(5);
  expect(kunmingMileageFare(19.01)).toBe(6);
  expect(kunmingMileageFare(26)).toBe(6);
  expect(kunmingMileageFare(26.01)).toBe(7);
  expect(kunmingMileageFare(34)).toBe(7);
  expect(kunmingMileageFare(34.01)).toBe(8);
  expect(kunmingMileageFare(43)).toBe(8);
  expect(kunmingMileageFare(43.01)).toBe(9);
  expect(kunmingMileageFare(53)).toBe(9);
  expect(kunmingMileageFare(53.01)).toBe(10);
  // 实测样本：昆明火车站 → 联大街 22.67 km 规划器报价 6 元；
  // 塘子巷 → 机场中心 24.86 km 报价 6 元。
  expect(kunmingMileageFare(22.67)).toBe(6);
  expect(kunmingMileageFare(24.86)).toBe(6);
});

test('station names fold onto the operator published names', () => {
  // AMap annotates the interchange with its exits; both records are the same
  // physical station and must fold together.
  expect(foldAmapStationName('环城南路(北部汽车站)')).toBe('环城南路');
  expect(foldAmapStationName('环城南路(昆明南火车站/大学城南·云南开放大学)')).toBe('环城南路');
  // AMap appends a neighbouring landmark.
  expect(foldAmapStationName('金桂街·斗南花市')).toBe('金桂街');
  expect(foldAmapStationName('大学城南·云南开放大学')).toBe('大学城南');
  // Corrections where AMap does not publish the operator name.
  expect(foldAmapStationName('眠山')).toBe('岷山');
  expect(foldAmapStationName('庄家塘立交桥')).toBe('庄家塘');
  expect(foldAmapStationName('昆明南火车站')).toBe('昆明南');
  expect(foldAmapStationName('市级行政中心清风')).toBe('市级行政中心');
  // A plain name only loses the trailing 站, as everywhere else in the repo.
  expect(foldAmapStationName('东部汽车站')).toBe('东部汽车');
});

test('planner service labels split into their two ends', () => {
  const parsed = parseServicePattern('地铁1号线(环城南路(北部汽车站)--大学城南·云南开放大学)');
  expect(parsed?.line).toBe('地铁1号线');
  expect(parsed?.origin).toBe('环城南路(北部汽车站)');
  expect(parsed?.destination).toBe('大学城南·云南开放大学');
  // The branch service.
  const branch = parseServicePattern('地铁1号线(环城南路(北部汽车站)--昆明南火车站)');
  expect(branch?.origin).toBe('环城南路(北部汽车站)');
  expect(branch?.destination).toBe('昆明南火车站');
  expect(parseServicePattern(undefined)).toBeNull();
  expect(parseServicePattern('no parens')).toBeNull();
});

test('planner geometry parses the Kunming comma separated pairs', () => {
  const points = parsePlannerCoordPairs('102.723795,25.013698,102.723906,25.013159');
  expect(points).toHaveLength(2);
  expect(points[0]?.lon).toBeCloseTo(102.723795, 6);
  expect(points[0]?.lat).toBeCloseTo(25.013698, 6);
  expect(parsePlannerCoordPairs(undefined)).toEqual([]);
});

test('a whole-line polyline splits at the stations', () => {
  const points = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 2, lat: 0 },
    { lon: 3, lat: 0 }
  ];
  const slices = splitPolylineByStations(points, [
    { lon: 0, lat: 0 },
    { lon: 2, lat: 0 }
  ]);
  expect(slices).toHaveLength(1);
  expect(slices?.[0]).toHaveLength(3);
  // A station that is not on the polyline still yields a best-effort cut.
  expect(splitPolylineByStations(points, [])).toBeUndefined();
  expect(splitPolylineByStations([], [])).toBeUndefined();
});

/**
 * A miniature Kunming: Line 1 with a main alignment and a branch that diverges
 * at the third station, Line 2 sharing the first station with it — the shape
 * of Line 1 / Line 2 at 环城南路 — plus one minimal alignment for every other
 * configured line.
 */
function fixture(): AmapSubwayDoc {
  const station = (n: string, lon: number, lat: number) => ({
    n,
    sl: `${lon},${lat}`,
    poiid: `BV${n}`,
    sid: `sid-${n}`,
    si: `si-${n}`,
    p: '0 0',
    multilang: { n: { en: n } }
  });
  const main = [
    station('A', 0, 0),
    station('B', 1, 0),
    station('J', 2, 0),
    station('C', 3, 0),
    station('E', 4, 0)
  ];
  const branch = [station('A', 0, 0), station('B', 1, 0), station('J', 2, 0), station('D', 5, 0)];
  const lines: AmapSubwayDoc['l'] = [
    { ln: '1号线', kn: '地铁1号线', cl: 'FC0601', st: main },
    { ln: '1号线', kn: '地铁1号线', cl: 'FC0601', st: branch },
    {
      ln: '2号线',
      kn: '地铁2号线',
      cl: '0065B3',
      st: [station('A', 0, 0), station('E', 0, -1), station('F', 0, -2)]
    }
  ];
  for (const n of [3, 4, 5, 6]) {
    lines.push({
      ln: `${n}号线`,
      kn: `地铁${n}号线`,
      cl: '00AB4F',
      st: [station(`L${n}a`, 10 + n, 0), station(`L${n}b`, 11 + n, 0)]
    });
  }
  return { s: '测试市地铁', i: '9999', l: lines };
}

test('a branch alignment starts at the junction and shares only that stop', () => {
  const topology = buildKunmingTopology(fixture());
  expect(topology.lines).toHaveLength(6);
  // Line 1 owns two alignments; every other line one.
  expect(topology.patterns).toHaveLength(7);

  const primary = topology.patterns.find((p) => p.is_primary)!;
  const branch = topology.patterns.find((p) => !p.is_primary)!;
  expect(primary.stop_ids).toHaveLength(5);
  // The branch runs from the junction onwards, never repeating the trunk.
  expect(branch.stop_ids).toHaveLength(2);
  expect(branch.junction_stop_id).toBe(primary.stop_ids[2]);
  expect(branch.origin_stop_id).toBe(primary.stop_ids[2]);

  // The junction is the only stop the two alignments share.
  const shared = primary.stop_ids.filter((id) => branch.stop_ids.includes(id));
  expect(shared).toEqual([primary.stop_ids[2]]);

  // Segment sequences stay unique within a line: the trunk keeps 0…n-1 and
  // the branch-only stations continue the count.
  const sequences = topology.stops
    .filter((s) => s.line_id === primary.line_id)
    .map((s) => s.sequence)
    .sort((a, b) => a - b);
  expect(sequences).toEqual([0, 1, 2, 3, 4, 5]);
});

test('a station served by two lines is one physical station', () => {
  const topology = buildKunmingTopology(fixture());
  // "A" is the first stop of Line 1 and of Line 2 — it must be one station.
  const a = topology.stations.find((s) => s.name === 'A')!;
  const stopsOfA = topology.stops.filter((s) => s.station_id === a.id);
  expect(stopsOfA).toHaveLength(2);
  expect(new Set(stopsOfA.map((s) => s.line_id)).size).toBe(2);
  // A, B, J, C, E, D (Line 1) + F (Line 2) + two per remaining line.
  expect(topology.stations).toHaveLength(15);
});
