import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  parseFare,
  parseLrtEdges,
  parseOptions,
  parseStationMap,
  parseTimetable
} from '../src/fetch.js';

const fixture = (name: string) => readFileSync(`${import.meta.dir}/fixtures/${name}`, 'utf8');

test('operator map yields bilingual identity and a search centre for rail geocoding', () => {
  expect(parseStationMap(fixture('map.html'))).toEqual({
    zh: '美麗島',
    en: 'Formosa Boulevard',
    location: { lon: 120.301913, lat: 22.631389, crs: 'wgs84' }
  });
  expect(parseStationMap(fixture('lrt-map.html')).en).toBe('Lizihnei');
  expect(() => parseStationMap('<html>maintenance</html>')).toThrow();
});

test('official light rail matrix preserves both directions and closes the ring', () => {
  const edges = parseLrtEdges(fixture('travel-matrix.html'));
  expect(edges).toHaveLength(76);
  expect(edges.find((e) => e.from === 'C2' && e.to === 'C3')?.seconds).toBe(180);
  expect(edges.find((e) => e.from === 'C3' && e.to === 'C2')?.seconds).toBe(120);
  expect(edges.find((e) => e.from === 'C37' && e.to === 'C1')?.seconds).toBe(120);
  expect(edges.find((e) => e.from === 'C1' && e.to === 'C37')?.seconds).toBe(120);
  expect(edges.some((e) => e.from === 'C21A' && e.to === 'C21')).toBe(true);
  expect(() => parseLrtEdges('<table><tr><td>broken</td></tr></table>')).toThrow();
});

test('metro timetable retains both destinations and seven day types', () => {
  const rows = parseTimetable(fixture('timetable.html'), false);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.destination).toBe('岡山車站');
  expect(rows[0]?.first).toEqual(['05:58', '05:58', '05:58', '05:58', '05:58', '05:58', '05:58']);
  expect(rows[1]?.last).toEqual(['24:32', '24:32', '24:32', '24:32', '24:32', '24:32', '24:32']);
});

test('light rail keeps clockwise and counterclockwise holiday differences', () => {
  const rows = parseTimetable(fixture('lrt-timetable.html'), true);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.direction).toBe('loop_outer');
  expect(rows[1]?.direction).toBe('loop_inner');
  expect(rows[1]?.last).toEqual(['22:35', '22:35', '22:35', '22:35', '22:35', '22:30', '22:30']);
});

test('planner uses full fare and rejects a zero quote for distinct stations', () => {
  expect(parseFare('<em>行駛時間</em>約31分鐘<em>單程票/普卡</em>30元<em>社福卡</em>15元')).toEqual(
    { fare: 30, seconds: 1860 }
  );
  expect(() => parseFare('<em>行駛時間</em>0分<em>單程票/普卡</em>0元')).toThrow();
  expect(parseOptions('<option value="鳳山西站">O11 鳳山西站(高雄市議會)</option>')).toEqual([
    { value: '鳳山西站', code: 'O11', name: '鳳山西站(高雄市議會)' }
  ]);
});
