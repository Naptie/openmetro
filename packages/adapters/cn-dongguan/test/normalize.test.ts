import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeTimetableTimes } from '@openmetro/core';
import type { DongguanSources } from '../src/fetch.js';
import { normalizeDongguan } from '../src/normalize.js';

const sources: DongguanSources = {
  amap: JSON.parse(readFileSync(new URL('./fixtures/amap.json', import.meta.url), 'utf8')),
  timetableHtml: readFileSync(new URL('./fixtures/timetable.html', import.meta.url), 'utf8'),
  timetableUrl: 'https://www.dggdjt.com/info/17798.htmx'
};

test('two current lines share Civic Center and provide 76 directional weekly timetables', () => {
  const c = normalizeDongguan(sources);
  expect([
    c.lines.length,
    c.stations.length,
    c.stops.length,
    c.patterns.length,
    c.segments.length
  ]).toEqual([2, 39, 40, 2, 38]);
  expect(c.timetables.length).toBe(76);
  const interchange = c.stations.find((s) => s.name === '市民中心')!;
  expect(c.stops.filter((s) => s.station_id === interchange.id).length).toBe(2);
  expect(new Set(c.stations.map((s) => s.id)).size).toBe(39);
  expect(c.stations.every((s) => s.location?.crs === 'gcj02' && /[A-Za-z]/.test(s.names.en))).toBe(
    true
  );
  const toHumen = c.timetables.find(
    (t) =>
      t.station_id === interchange.id &&
      t.line_id.endsWith('-2') &&
      t.direction_label?.includes('虎门')
  )!;
  expect(toHumen.first_train).toEqual([
    '06:35',
    '06:35',
    '06:35',
    '06:35',
    '06:35',
    '06:38',
    '06:38'
  ]);
  const midnight = c.timetables.find(
    (t) =>
      c.stations.find((s) => s.id === t.station_id)?.name === '厚德' &&
      t.direction_label?.includes('东莞西')
  )!;
  expect(normalizeTimetableTimes(midnight).last_train).toEqual(Array(7).fill('24:06'));
  expect(c.timetables.every((t) => t.stop_id !== t.destination_stop_id)).toBe(true);
});

test('refuses stale AMap topology rather than disconnecting the official station order', () => {
  const stale = structuredClone(sources);
  stale.amap.l[0]!.st.splice(8, 1);
  expect(() => normalizeDongguan(stale)).toThrow();
});

test('station identity survives an English name correction', () => {
  const corrected = structuredClone(sources);
  for (const line of corrected.amap.l) {
    for (const station of line.st) {
      if (station.n === '市民中心') station.multilang!.n!.en = 'Shimin Zhongxin';
    }
  }
  const before = normalizeDongguan(sources).stations.find((s) => s.name === '市民中心')!;
  const after = normalizeDongguan(corrected).stations.find((s) => s.name === '市民中心')!;
  expect(after.names.en).toBe('Shimin Zhongxin');
  expect(after.id).toBe(before.id);
});
