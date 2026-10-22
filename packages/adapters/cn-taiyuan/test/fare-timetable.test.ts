import { expect, test } from 'bun:test';
import { officialTariffFare } from '../src/fares.ts';
import { toHHMM } from '../src/normalize.ts';

test('distance ladder matches the published Taiyuan tariff', () => {
  // 里程分段计价票制：起步价 2 元可乘坐 5 公里；5 公里以上部分，票价每增加
  // 1 元的晋级里程为 5、5、6、6、7 公里，不设置封顶票价。
  expect(officialTariffFare(0)).toBe(0);
  expect(officialTariffFare(1.2)).toBe(2);
  expect(officialTariffFare(5)).toBe(2);
  expect(officialTariffFare(5.01)).toBe(3);
  expect(officialTariffFare(10)).toBe(3);
  expect(officialTariffFare(15)).toBe(4);
  expect(officialTariffFare(21)).toBe(5);
  expect(officialTariffFare(27)).toBe(6);
  expect(officialTariffFare(34)).toBe(7);
  expect(officialTariffFare(41)).toBe(8);
  // 6 元以上每增加 1 元可乘坐 7 公里。
  expect(officialTariffFare(48)).toBe(9);
  expect(officialTariffFare(55)).toBe(10);
  // 1 号线全程 28.737 km → 7 元；2 号线一期全程 23.647 km → 6 元，
  // 与开通公告公布的「2 号线一期全程最高票价 6 元」一致。
  expect(officialTariffFare(28.737)).toBe(7);
  expect(officialTariffFare(23.647)).toBe(6);
});

test('source clock times collapse to the canonical HH:MM form', () => {
  // The operator publishes seconds; the canonical timetable keeps HH:MM and
  // stores the exact value in extras.
  expect(toHHMM('06:02:12')).toBe('06:02');
  expect(toHHMM('22:49:14')).toBe('22:49');
  expect(toHHMM('06:00:00')).toBe('06:00');
  expect(toHHMM('6:05')).toBe('06:05');
  // A terminal has no service in that direction.
  expect(toHHMM('终点站')).toBeUndefined();
  expect(toHHMM(null)).toBeUndefined();
  expect(toHHMM('')).toBeUndefined();
  expect(toHHMM('not a time')).toBeUndefined();
});
