import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeTaichung, parseCsv } from '../src/normalize.js';

const fixture = (name: string) => readFileSync(`${import.meta.dir}/fixtures/${name}`, 'utf8');
const sources = () => ({
  officialStations: JSON.parse(fixture('official-stations.json')),
  stations: parseCsv(fixture('stations.csv')),
  runtimes: parseCsv(fixture('runtimes.csv')),
  timetables: parseCsv(fixture('timetables.csv')),
  fares: JSON.parse(fixture('fares.json'))
});

test('CSV handles BOM, escaped quotes, commas and embedded newlines', () => {
  expect(parseCsv('\uFEFFname,address\r\n"A""B","road,\ncity"\r\n')).toEqual([
    { name: 'A"B', address: 'road,\ncity' }
  ]);
});

test('official sources produce full topology, asymmetric running times and daily service', () => {
  const data = normalizeTaichung(sources());
  expect(data.stations).toHaveLength(18);
  expect(data.stops).toHaveLength(18);
  expect(data.segments).toHaveLength(34);
  expect(data.timetables).toHaveLength(34);
  const fromBeitun = data.segments.find((s) => s.from_station_id === 'cn-taichung-103a');
  expect(fromBeitun?.travel_time_seconds).toBe(124);
  const toBeitun = data.segments.find((s) => s.to_station_id === 'cn-taichung-103a');
  expect(toBeitun?.travel_time_seconds).toBe(127);
  expect(data.stations[0]?.location).toEqual({ lon: 120.70864, lat: 24.189132, crs: 'wgs84' });
  expect(data.timetables.some((t) => t.last_train.includes('24:27'))).toBe(true);
  expect(data.fares.fares.flat().every((v) => v !== null)).toBe(true);
  expect(new Set(data.stations.map((s) => s.id)).size).toBe(18);
  expect(data.stations.find((s) => s.name === '烏日')?.id).toBe('cn-taichung-118');
  expect(data.stations.find((s) => s.name === '高鐵臺中站')?.id).toBe('cn-taichung-119');
  const a = data.fares.station_ids.indexOf('cn-taichung-103a');
  const b = data.fares.station_ids.indexOf('cn-taichung-119');
  expect(data.fares.fares[a]?.[b]).toBe(50);
  expect(data.fares.fares[b]?.[a]).toBe(50);
});

test('missing official runtime fails instead of inventing a travel time', () => {
  const input = sources();
  input.runtimes.shift();
  expect(() => normalizeTaichung(input)).toThrow();
});
