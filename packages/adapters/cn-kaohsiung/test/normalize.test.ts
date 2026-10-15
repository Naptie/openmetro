import { expect, test } from 'bun:test';
import type { KaohsiungSources, SourceStation } from '../src/fetch.js';
import { normalizeKaohsiung, retainFares } from '../src/normalize.js';

function sources(): KaohsiungSources {
  const station = (
    key: string,
    zh: string,
    lon: number,
    lat: number,
    codes = [key]
  ): SourceStation => ({
    key,
    codes,
    zh,
    en: `Station ${key}`,
    section: key.startsWith('C') ? 'KLRT' : 'Guide',
    url: `https://www.krtc.com.tw/${key}`,
    osmId: `N/${key}`,
    location: { lon, lat, crs: 'wgs84' }
  });
  return {
    stations: [
      station('R3', '南端', 120.35, 22.56),
      station('R10', '交會站', 120.3, 22.63, ['R10', 'O5']),
      station('O1', '西端', 120.27, 22.62),
      station('C1', '輕軌甲', 120.35, 22.58),
      station('C2', '輕軌乙', 120.36, 22.59),
      station('C3', '輕軌丙', 120.37, 22.58)
    ],
    lines: [
      { code: 'R', stops: ['R3', 'R10'] },
      { code: 'O', stops: ['O1', 'O5'] },
      { code: 'C', stops: ['C1', 'C2', 'C3'] }
    ],
    quotes: [
      { from: 'R3', to: 'R10', fare: 25, seconds: 600 },
      { from: 'R10', to: 'R3', fare: 25, seconds: 600 },
      { from: 'O1', to: 'O5', fare: 20, seconds: 300 },
      { from: 'O5', to: 'O1', fare: 20, seconds: 300 },
      { from: 'C1', to: 'C2', fare: 20, seconds: 120 }
    ],
    lrtEdges: [
      { from: 'C1', to: 'C2', seconds: 120 },
      { from: 'C2', to: 'C1', seconds: 180 },
      { from: 'C2', to: 'C3', seconds: 120 },
      { from: 'C3', to: 'C2', seconds: 120 },
      { from: 'C3', to: 'C1', seconds: 180 },
      { from: 'C1', to: 'C3', seconds: 180 }
    ],
    timetables: ['R3', 'R10', 'O1', 'O5', 'C1', 'C2', 'C3'].map((code) => ({
      code,
      rows: [
        ...(code.startsWith('C')
          ? [{ direction: 'loop_inner' as const, first: ['06:00'], last: ['00:15'] }]
          : []),
        {
          direction: code.startsWith('C') ? 'loop_outer' : 'linear',
          destination:
            code === 'R3' ? '交會站' : code === 'R10' ? '南端' : code === 'O1' ? '交會站' : '西端',
          first: ['06:00'],
          last: ['00:15']
        }
      ]
    }))
  };
}

test('shared metro identity has separate stops and complete directional transfers', () => {
  const data = normalizeKaohsiung(sources());
  expect(data.stations).toHaveLength(6);
  expect(data.stops).toHaveLength(7);
  expect(data.transfers).toHaveLength(2);
  expect(data.transfers.map((t) => [t.from_stop_id, t.to_stop_id])).toEqual([
    ['cn-kaohsiung-stop-r10', 'cn-kaohsiung-stop-o5'],
    ['cn-kaohsiung-stop-o5', 'cn-kaohsiung-stop-r10']
  ]);
  expect(data.timetables.every((t) => t.last_train[0] === '24:15')).toBe(true);
});

test('loop has directed closing edges and separate MRT/LRT fares remain unknown', () => {
  const data = normalizeKaohsiung(sources());
  expect(data.segments.filter((s) => s.line_id.endsWith('-c'))).toHaveLength(6);
  expect(
    data.segments.find((s) => s.from_stop_id.endsWith('-c3') && s.to_stop_id.endsWith('-c1'))
      ?.direction
  ).toBe('forward');
  const ids = data.fares.station_ids;
  const r = ids.indexOf('cn-kaohsiung-r3');
  const a = ids.indexOf('cn-kaohsiung-c1');
  const b = ids.indexOf('cn-kaohsiung-c2');
  expect(data.fares.fares[r]?.[a]).toBeNull();
  expect(data.fares.fares[a]?.[b]).toBe(20);
  expect(data.fares.fares[b]?.[a]).toBe(20);
});

test('missing ring edge or missing service fails instead of publishing a partial network', () => {
  const input = sources();
  input.lrtEdges.pop();
  expect(() => normalizeKaohsiung(input)).toThrow('Incomplete KRTC light rail ring');
  const other = sources();
  other.timetables.pop();
  expect(() => normalizeKaohsiung(other)).toThrow('Missing timetable');
});

test('topology refresh rekeys old fares, keeps fresh quotes, and preserves retrieval dates', () => {
  const data = normalizeKaohsiung(sources());
  const previous = {
    ...data.fares,
    station_ids: ['cn-kaohsiung-c2', 'cn-kaohsiung-c1', 'cn-kaohsiung-c3', 'removed'],
    fares: [
      [0, 30, 40, 50],
      [30, 0, 40, 50],
      [40, 40, 0, 50],
      [50, 50, 50, 0]
    ],
    source: [
      {
        name: 'krtc-planner',
        url: 'https://www.krtc.com.tw/',
        version: 'live',
        retrieved_at: '2026-09-01T00:00:00Z',
        license: 'unknown' as const,
        license_url: null,
        attribution: 'KRTC'
      }
    ]
  };
  data.fares.fares[data.fares.station_ids.indexOf('cn-kaohsiung-c1')]![
    data.fares.station_ids.indexOf('cn-kaohsiung-c3')
  ] = null;
  const merged = retainFares(data.fares, previous);
  expect(merged.station_ids.includes('removed')).toBe(false);
  const a = merged.station_ids.indexOf('cn-kaohsiung-c1');
  const b = merged.station_ids.indexOf('cn-kaohsiung-c2');
  const c = merged.station_ids.indexOf('cn-kaohsiung-c3');
  expect(merged.fares[a]?.[b]).toBe(20);
  expect(merged.fares[a]?.[c]).toBe(40);
  expect(merged.source[0]?.retrieved_at).toBe('2026-09-01T00:00:00Z');
});

test('one missing ring direction is rejected even when other stations have both', () => {
  const input = sources();
  input.timetables.find((t) => t.code === 'C2')!.rows.pop();
  expect(() => normalizeKaohsiung(input)).toThrow();
});

test('MRT edge weights difference cumulative journeys rather than sum rounded adjacent minutes', () => {
  const input = sources();
  input.stations.push({
    ...input.stations[0]!,
    key: 'R6',
    codes: ['R6'],
    zh: '中站',
    en: 'Middle'
  });
  input.lines[0]!.stops = ['R3', 'R6', 'R10'];
  input.quotes.push(
    { from: 'R3', to: 'R6', fare: 20, seconds: 360 },
    { from: 'R6', to: 'R3', fare: 20, seconds: 360 },
    { from: 'R10', to: 'R6', fare: 20, seconds: 300 },
    { from: 'R6', to: 'R10', fare: 20, seconds: 300 }
  );
  input.timetables.push({
    code: 'R6',
    rows: [
      { direction: 'linear', destination: '南端', first: ['06:00'], last: ['00:15'] },
      { direction: 'linear', destination: '交會站', first: ['06:00'], last: ['00:15'] }
    ]
  });
  const result = normalizeKaohsiung(input);
  const edge = result.segments.find(
    (s) => s.from_stop_id.endsWith('-r6') && s.to_stop_id.endsWith('-r10')
  );
  expect(edge?.travel_time_seconds).toBe(240);
  const missing = sources();
  missing.timetables[0]!.rows.push({ ...missing.timetables[0]!.rows[0]! });
  expect(() => normalizeKaohsiung(missing)).toThrow();
});
