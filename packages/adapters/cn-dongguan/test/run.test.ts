import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepoRoot } from '@openmetro/core';
import { syncDongguanFares } from '../src/fares.js';
import { runDongguanNormalize } from '../src/run.js';

const amap = readFileSync(new URL('./fixtures/amap.json', import.meta.url), 'utf8');
const html = readFileSync(new URL('./fixtures/timetable.html', import.meta.url), 'utf8');

test('normal sync retains planner measurements and rejects a reduced fare harvest', async () => {
  const tmp = join(findRepoRoot(import.meta.dir), 'tmp');
  await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(join(tmp, 'dongguan-test-'));
  const dir = join(root, 'data/cn-dongguan');
  const read = async (name: string) =>
    JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
  const write = (name: string, value: unknown) =>
    writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('amap.com')) return new Response(amap);
    if (url.includes('/node/121'))
      return new Response(
        '<li><a href="/info/17798.htmx">服务时间</a><span>2026-10-05</span></li>'
      );
    return new Response(html);
  });
  try {
    await runDongguanNormalize({ root });
    const segments = await read('segments');
    const transfers = await read('transfers');
    segments.records[0].travel_time_seconds = 99;
    segments.records[0].travel_time_source = 'planner';
    segments.records[0].extras.planner_time_source = 'baidu-transit';
    transfers.records[0].walk_time_seconds = 240;
    transfers.records[0].walk_distance_meters = 180;
    transfers.records[0].source_id = 'baidu-transit';
    transfers.records[0].extras = { walk_source: 'baidu-transit' };
    transfers.records[1].walk_time_seconds = 300;
    transfers.records[1].walk_distance_meters = 210;
    transfers.records[1].source_id = 'baidu-transit';
    transfers.records[1].extras = { walk_source: 'baidu-transit' };
    const plannerSource = {
      ...segments.source[0],
      name: 'baidu',
      url: 'https://api.map.baidu.com/directionlite/v1/transit'
    };
    segments.source.push(plannerSource);
    transfers.source.push(plannerSource);
    await write('segments', segments);
    await write('transfers', transfers);
    await runDongguanNormalize({ root });
    const next = await read('segments');
    expect(next.records[0].travel_time_seconds).toBe(99);
    expect(next.records[0].travel_time_source).toBe('planner');
    expect(next.source.some((s: { name: string }) => s.name === 'baidu')).toBe(true);
    const nextTransfers = (await read('transfers')).records;
    expect(nextTransfers[0].walk_time_seconds).toBe(240);
    expect(nextTransfers[0].walk_distance_meters).toBe(180);
    expect(nextTransfers[0].extras.walk_source).toBe('baidu-transit');
    expect(nextTransfers[1].walk_time_seconds).toBe(300);
    expect(nextTransfers[1].walk_distance_meters).toBe(210);
    expect(nextTransfers[1].extras.walk_source).toBe('baidu-transit');

    const stations = (await read('stations')).records;
    const previous = await read('fares');
    // A formerly supported Line 1 pair must not silently become unknown.
    const a = previous.station_ids.indexOf(
      stations.find((s: { name: string }) => s.name === '厚德').id
    );
    const b = previous.station_ids.indexOf(
      stations.find((s: { name: string }) => s.name === '昌平').id
    );
    previous.fares[a][b] = previous.fares[b][a] = 2;
    await write('fares', previous);
    const catalog = JSON.parse(amap)
      .l.find((l: { ln: string }) => l.ln === '2号线')
      .st.map((s: { n: string }, i: number) => ({ id: i + 1, name: s.n, seq: i + 1, removed: 0 }));
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = Number(url.searchParams.get('lineId'));
      if (url.pathname.includes('/line.htmx'))
        return Response.json({
          info: { success: true },
          data: [{ id, stations: id === 2 ? catalog : [] }]
        });
      return Response.json({
        info: { success: true },
        data: [
          {
            price: '2',
            startStation: { id: Number(url.searchParams.get('startId')) },
            endStation: { id: Number(url.searchParams.get('endId')) }
          }
        ]
      });
    });
    await expect(syncDongguanFares(dir)).rejects.toThrow();
    expect((await read('fares')).fares[a][b]).toBe(2);
    catalog[0].name = 'Unknown station';
    await expect(syncDongguanFares(dir)).rejects.toThrow('Unmatched fare station');
    expect((await read('fares')).fares[a][b]).toBe(2);
  } finally {
    fetchMock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
