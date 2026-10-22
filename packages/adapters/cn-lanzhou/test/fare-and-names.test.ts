import { expect, test } from 'bun:test';
import { foldStopName, pickOriginLeg, stopNameMatches } from '../src/baidu.ts';
import { buildLanzhouFareMatrix, verifyFareMatrixAgainstTariff } from '../src/fares.ts';
import { lanzhouMileageFare } from '../src/lines.ts';
import { foldLanzhouStationName, stationAlias } from '../src/normalize.ts';

test("station names fold across the operator's four spellings", () => {
  // The network literal and the fare matrix use the short name; the
  // timetable sheets and AMap append the alias in brackets.
  expect(foldLanzhouStationName('兰州城市学院')).toBe('兰州城市学院');
  expect(foldLanzhouStationName('兰州城市学院(省科技馆)')).toBe('兰州城市学院');
  expect(foldLanzhouStationName('兰州城市学院（省科技馆）')).toBe('兰州城市学院');
  // The operator's sheets append 站.
  expect(foldLanzhouStationName('东方红广场站')).toBe('东方红广场');
  expect(foldLanzhouStationName('西站什字站')).toBe('西站什字');
  expect(stationAlias('兰州城市学院(省科技馆)')).toBe('省科技馆');
  expect(stationAlias('东方红广场')).toBeUndefined();
});

test("planner stop names match the operator's station names", () => {
  expect(foldStopName('东方红广场站(A口)')).toBe('东方红广场站');
  expect(foldStopName('兰州西站北广场站(C口)')).toBe('兰州西站北广场站');
  // Only a trailing 站 may differ between the planner and the operator.
  expect(stopNameMatches('东方红广场站(A口)', '东方红广场')).toBe(true);
  expect(stopNameMatches('东方红广场站', '东方红广场')).toBe(true);
  expect(stopNameMatches('兰州火车站(C口)', '兰州火车站')).toBe(true);
  expect(stopNameMatches('东方红广场站(A口)', '西站什字')).toBe(false);
  expect(stopNameMatches('', '东方红广场')).toBe(false);
});

test('the leg picker prefers the ride that boards at the queried station', () => {
  // The planner answers 东方红广场 → 雁白大桥 with two Line-2 legs: one that
  // boards at 东方红广场 (the direct ride) and one that boards at 五里铺
  // (the tail of a transfer route). The operator's sheet says 23:03, which
  // is the direct ride.
  const legs = [
    {
      lineName: '轨道交通2号线',
      direction: '雁白大桥方向',
      lineColor: '#EF4921',
      onStation: '五里铺站(A口)',
      offStation: '雁白大桥站(D口)',
      firstTime: '06:30',
      lastTime: '23:14',
      durationSeconds: 300,
      distanceMeters: 3191,
      stopNames: ['张苏滩', '均家滩']
    },
    {
      lineName: '轨道交通2号线',
      direction: '雁白大桥方向',
      lineColor: '#EF4921',
      onStation: '东方红广场站(A口)',
      offStation: '雁白大桥站(D口)',
      firstTime: '06:30',
      lastTime: '23:03',
      durationSeconds: 900,
      distanceMeters: 6132,
      stopNames: ['邮电大楼', '兰州火车站', '红星巷', '团结新村', '五里铺', '张苏滩', '均家滩']
    }
  ];

  const picked = pickOriginLeg(legs, { originName: '东方红广场', lineHint: '轨道交通2号线' });
  expect(picked?.lastTime).toBe('23:03');

  // Without the boarding-station rule the transfer's tail would win.
  const wrong = pickOriginLeg(legs, { originName: '五里铺', lineHint: '轨道交通2号线' });
  expect(wrong?.lastTime).toBe('23:14');

  // A leg on another line is never accepted.
  expect(
    pickOriginLeg(legs, { originName: '东方红广场', lineHint: '轨道交通1号线' })
  ).toBeUndefined();
});

test("the published mileage tariff matches the operator's policy", () => {
  // 起步价 2 元 / 4 公里（含），晋级里程 4、4、6、6、8、8：
  // 3 元 8 公里、4 元 12 公里、5 元 18 公里、6 元 24 公里、
  // 7 元 32 公里、8 元 40 公里，40 公里以上每加 1 元多乘 8 公里。
  expect(lanzhouMileageFare(0)).toBe(2);
  expect(lanzhouMileageFare(4)).toBe(2);
  expect(lanzhouMileageFare(4.01)).toBe(3);
  expect(lanzhouMileageFare(8)).toBe(3);
  expect(lanzhouMileageFare(12)).toBe(4);
  expect(lanzhouMileageFare(18)).toBe(5);
  expect(lanzhouMileageFare(24)).toBe(6);
  expect(lanzhouMileageFare(32)).toBe(7);
  expect(lanzhouMileageFare(40)).toBe(8);
  expect(lanzhouMileageFare(40.01)).toBe(9);
  expect(lanzhouMileageFare(48)).toBe(9);
  expect(lanzhouMileageFare(48.01)).toBe(10);
});

test('the official fare matrix becomes a symmetric canonical matrix', () => {
  // A three-station excerpt of the operator's matrix, with the alias and the
  // 站 suffix spelled the way each source spells them.
  const official = {
    陈官营: { 奥体中心: 2, '兰州城市学院(省科技馆)': 2, 东岗: 7 },
    '兰州城市学院(省科技馆)': { 陈官营: 2, 奥体中心: 2, 东岗: 6 },
    东岗: { 陈官营: 7, 奥体中心: 6, '兰州城市学院(省科技馆)': 6 },
    奥体中心: { 陈官营: 2, '兰州城市学院(省科技馆)': 2, 东岗: 6 }
  };
  const stationIds = ['a', 'b', 'c', 'd'];
  const stationNameById = new Map([
    ['a', '陈官营'],
    ['b', '奥体中心'],
    ['c', '兰州城市学院'],
    ['d', '东岗']
  ]);

  const m = buildLanzhouFareMatrix({ stationIds, stationNameById, official });
  const at = (from: string, to: string) => {
    const i = stationIds.indexOf(from);
    const j = stationIds.indexOf(to);
    return m.fares[i]![j];
  };
  // The alias spelling in the matrix still resolves to the canonical station.
  expect(at('a', 'c')).toBe(2);
  expect(at('c', 'a')).toBe(2);
  expect(at('a', 'd')).toBe(7);
  expect(at('d', 'a')).toBe(7);
  // The diagonal is free.
  expect(at('a', 'a')).toBe(0);
  // Symmetric everywhere.
  for (const x of stationIds) {
    for (const y of stationIds) expect(at(x, y)).toBe(at(y, x));
  }
});

test('a station the operator does not price is refused', () => {
  expect(() =>
    buildLanzhouFareMatrix({
      stationIds: ['a', 'b'],
      stationNameById: new Map([
        ['a', '陈官营'],
        ['b', '不在票价表中的站']
      ]),
      official: { 陈官营: { 东岗: 7 } }
    })
  ).toThrow(/does not cover/);
});

test('the published matrix agrees with the published tariff', () => {
  // A two-station case: 5 km apart, priced 3 yuan — the tariff band for
  // 4–8 km.
  const m = buildLanzhouFareMatrix({
    stationIds: ['a', 'b'],
    stationNameById: new Map([
      ['a', '陈官营'],
      ['b', '东岗']
    ]),
    official: { 陈官营: { 东岗: 3 }, 东岗: { 陈官营: 3 } }
  });
  const check = verifyFareMatrixAgainstTariff(m, () => 5, lanzhouMileageFare);
  expect(check.consistent).toBe(1);
  expect(check.inconsistent).toBe(0);
});
