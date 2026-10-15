import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApiApp } from '../src/api/app.js';
import { createMemoryNetworkSource } from '../src/data/memory.js';
import type { RawNetworkFiles } from '../src/data/types.js';

test('base fare qualification survives canonical decoding and every fare API', async () => {
  const raw = Object.fromEntries(
    [
      'network',
      'lines',
      'stations',
      'stops',
      'patterns',
      'segments',
      'transfers',
      'timetables',
      'fares'
    ].map((name) => [
      name,
      JSON.parse(
        readFileSync(new URL(`../../../data/cn-dongguan/${name}.json`, import.meta.url), 'utf8')
      )
    ])
  );
  raw.fares.basis = 'base';
  const app = createApiApp(
    createMemoryNetworkSource({ 'cn-dongguan': raw as unknown as RawNetworkFiles })
  );
  const from = raw.stations.records.find((s: { name: string }) => s.name === '东莞火车站').id;
  const to = raw.stations.records.find((s: { name: string }) => s.name === '虎门火车站').id;
  for (const path of ['fares', `fares?from=${from}`, `route?from=${from}&to=${to}`]) {
    const response = await app.handle(
      new Request(`http://localhost/api/networks/cn-dongguan/${path}`)
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(path.startsWith('route') ? data.fare_basis : data.basis).toBe('base');
  }
});
