import { expect, test } from 'bun:test';
import { computeFareMatrix, fareFromDistanceKm } from '../src/fares.ts';

test('distance ladder matches the published Dalian tariff', () => {
  // 6 公里以内（含）2 元，晋级里程 6,6,8,8,10,10,15,15… 公里
  expect(fareFromDistanceKm(0)).toBe(0);
  expect(fareFromDistanceKm(3)).toBe(2);
  expect(fareFromDistanceKm(6)).toBe(2);
  expect(fareFromDistanceKm(6.1)).toBe(3);
  expect(fareFromDistanceKm(12)).toBe(3);
  expect(fareFromDistanceKm(18)).toBe(4);
  expect(fareFromDistanceKm(26)).toBe(5);
  expect(fareFromDistanceKm(34)).toBe(6);
  expect(fareFromDistanceKm(44)).toBe(7);
  expect(fareFromDistanceKm(54)).toBe(8);
  // 54 公里以上：每增加 1 元可乘坐 15 公里
  expect(fareFromDistanceKm(69)).toBe(9);
  expect(fareFromDistanceKm(84)).toBe(10);
  // 全线网最长单程（普兰店振兴街→大连站，约 104 km 轨道里程）→ ¥12，
  // 落在官方公布的 ¥14 单程上限之内。
  expect(fareFromDistanceKm(104)).toBe(12);
});

test('matrix uses the shortest rail distance, not the straight line', () => {
  // A ↔ B directly (10 km), A ↔ C ↔ B detour (4 + 4 km). The ladder must
  // price A → B off the 8 km rail path (¥3), not the direct 10 km one.
  const stations = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }
  ];
  const segments = [
    {
      id: 's1',
      from_stop_id: 'a-s',
      to_stop_id: 'b-s',
      from_station_id: 'a',
      to_station_id: 'b',
      distance_km: 10
    },
    {
      id: 's2',
      from_stop_id: 'a-s',
      to_stop_id: 'c-s',
      from_station_id: 'a',
      to_station_id: 'c',
      distance_km: 4
    },
    {
      id: 's3',
      from_stop_id: 'c-s',
      to_stop_id: 'b-s',
      from_station_id: 'c',
      to_station_id: 'b',
      distance_km: 4
    }
  ];
  const m = computeFareMatrix(stations, segments);
  // A → B: the cheapest rail path is A → C → B = 8 km → ¥3.
  expect(m.fares[0]![1]).toBe(3);
  // A → C is 4 km → ¥2.
  expect(m.fares[0]![2]).toBe(2);
  // Diagonal is free.
  expect(m.fares[0]![0]).toBe(0);
  // Symmetric.
  expect(m.fares[1]![0]).toBe(m.fares[0]![1]);
});

test('unreachable pairs stay null instead of guessing', () => {
  const stations = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' }
  ];
  // No segments: nothing connects the two stations.
  const m = computeFareMatrix(stations, []);
  expect(m.fares[0]![1]).toBeNull();
  expect(m.fares[0]![0]).toBe(0);
});
