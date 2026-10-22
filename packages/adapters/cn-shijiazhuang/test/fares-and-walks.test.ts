import { expect, test } from 'bun:test';
import { foldStopName } from '../src/baidu.ts';
import { shijiazhuangMileageFare } from '../src/lines.ts';
import { stationHallWalk } from '../src/transfers.ts';

test('tariff is a threshold step function over the charged mileage', () => {
  // 起步价 6 公里 2 元; the bands step at 6/13/20/28/36/45/54/64… km.
  expect(shijiazhuangMileageFare(0)).toBe(2);
  expect(shijiazhuangMileageFare(6)).toBe(2);
  expect(shijiazhuangMileageFare(6.001)).toBe(3);
  expect(shijiazhuangMileageFare(13)).toBe(3);
  expect(shijiazhuangMileageFare(13.001)).toBe(4);
  expect(shijiazhuangMileageFare(20)).toBe(4);
  expect(shijiazhuangMileageFare(20.001)).toBe(5);
  expect(shijiazhuangMileageFare(28)).toBe(5);
  expect(shijiazhuangMileageFare(28.001)).toBe(6);
  expect(shijiazhuangMileageFare(36)).toBe(6);
  expect(shijiazhuangMileageFare(36.001)).toBe(7);
  expect(shijiazhuangMileageFare(54)).toBe(8);
  expect(shijiazhuangMileageFare(54.001)).toBe(9);
  expect(shijiazhuangMileageFare(64)).toBe(9);
  expect(shijiazhuangMileageFare(74)).toBe(10);
  expect(shijiazhuangMileageFare(100)).toBe(13);
});

test('tariff reproduces the operator prices quoted by the planner', () => {
  // Pair → Baidu Direction v2 route price (verified 2026-10-22).
  const cases: [number, number][] = [
    [3.0, 2], // 西王 → 时光街
    [9.514, 3], // 北国商城 → 西王
    [15.618, 4], // 柳辛庄 → 嘉华路
    [16.142, 4], // 白佛 → 西王
    [26.563, 5], // 乐乡 → 西三庄
    [27.376, 5], // 新百广场 → 福泽
    [33.507, 6] // 西王 → 福泽
  ];
  for (const [km, yuan] of cases) {
    expect(shijiazhuangMileageFare(km)).toBe(yuan);
  }
});

test('planner stop names fold to the operator station names', () => {
  // The trailing 站 is folded away (core `foldStationName`), and so are exit
  // suffixes. 石家庄站 and 石家庄东站 stay distinct after folding.
  expect(foldStopName('西王站(B东南口)')).toBe('西王');
  expect(foldStopName('石家庄站')).toBe('石家庄');
  expect(foldStopName('石家庄东站')).toBe('石家庄东');
  expect(foldStopName('庄窠·铁道大学站')).toBe('庄窠·铁道大学');
  expect(foldStopName('乐乡站')).toBe('乐乡');
  expect(foldStopName(undefined)).toBe('');
});

test('station-hall walk is read between the two rail legs only', () => {
  const steps = [
    { kind: 'walk' as const, walk: { distanceMeters: 341, durationSeconds: 286 } },
    {
      kind: 'rail' as const,
      leg: { lineName: '地铁1号线', onStation: '西王站(B东南口)', offStation: '北国商城站' }
    },
    { kind: 'walk' as const, walk: { distanceMeters: 231, durationSeconds: 193 } },
    {
      kind: 'rail' as const,
      leg: { lineName: '地铁2号线', onStation: '北国商城站', offStation: '嘉华路站(C西南口)' }
    },
    { kind: 'walk' as const, walk: { distanceMeters: 165, durationSeconds: 138 } }
  ];
  const walk = stationHallWalk(steps, '地铁1号线', '地铁2号线');
  expect(walk).not.toBeNull();
  expect(walk!.distanceMeters).toBe(231);
  expect(walk!.durationSeconds).toBe(193);
  expect(walk!.fromLeg.offStation).toBe('北国商城站');
  expect(walk!.toLeg.onStation).toBe('北国商城站');
});

test('station-hall walk rejects a route that does not chain the two lines', () => {
  const steps = [
    { kind: 'walk' as const, walk: { distanceMeters: 341, durationSeconds: 286 } },
    {
      kind: 'rail' as const,
      leg: { lineName: '地铁1号线', onStation: '西王站(B东南口)', offStation: '北国商城站' }
    },
    { kind: 'walk' as const, walk: { distanceMeters: 231, durationSeconds: 193 } },
    {
      kind: 'rail' as const,
      leg: { lineName: '地铁3号线', onStation: '北国商城站', offStation: '乐乡站' }
    }
  ];
  expect(stationHallWalk(steps, '地铁1号线', '地铁2号线')).toBeNull();
});
