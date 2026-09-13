import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncFares } from '../src/fares/sync.js';

interface TestStation {
  id: string;
  name: string;
}

async function makeCtx(
  stations: TestStation[],
  stops: { station_id: string; source_id?: string }[]
): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'openmetro-fares-'));
  await writeFile(join(dataDir, 'stations.json'), JSON.stringify({ records: stations }), 'utf-8');
  await writeFile(join(dataDir, 'stops.json'), JSON.stringify({ records: stops }), 'utf-8');
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('syncFares writes a symmetric matrix keyed by station id', async () => {
  const { dataDir, cleanup } = await makeCtx(
    [
      { id: 's-a', name: '甲' },
      { id: 's-b', name: '乙' },
      { id: 's-c', name: '丙' }
    ],
    []
  );
  try {
    const queries: string[] = [];
    await syncFares(
      { dataDir },
      {
        networkId: 'test',
        currency: 'CNY',
        unit: 'yuan',
        source: { name: 'test' },
        keyOf: (station) => station.name,
        query: async (a, b) => {
          queries.push(`${a}-${b}`);
          return { price: a.length + b.length, retry: false };
        }
      }
    );

    // Upper triangle only: 3 pairs for 3 stations.
    assert.equal(queries.length, 3);
    assert.deepEqual([...queries].sort(), ['甲-乙', '甲-丙', '乙-丙'].sort());

    const doc = JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8'));
    assert.equal(doc.network_id, 'test');
    assert.deepEqual(doc.station_ids, ['s-a', 's-b', 's-c']);
    const m: (number | null)[][] = doc.fares;
    for (let i = 0; i < 3; i++) assert.equal(m[i][i], 0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) if (i !== j) assert.equal(m[i][j], m[j][i]);
    assert.equal(m[0][1], '甲'.length + '乙'.length);
  } finally {
    await cleanup();
  }
});

test('syncFares keys stations via per-line stop source_id when requested', async () => {
  const { dataDir, cleanup } = await makeCtx(
    [
      { id: 's-a', name: '甲' },
      { id: 's-b', name: '乙' }
    ],
    [
      { station_id: 's-a', source_id: 'L01_05' },
      { station_id: 's-b', source_id: 'L02_11' }
    ]
  );
  try {
    const keys: string[] = [];
    await syncFares(
      { dataDir },
      {
        networkId: 'test',
        currency: 'CNY',
        unit: 'yuan',
        source: { name: 'test' },
        keyOf: (station, stopCode) => stopCode(station.id) ?? '',
        query: async (a, b) => {
          keys.push(`${a}|${b}`);
          return { price: 3, retry: false };
        }
      }
    );
    assert.deepEqual([...keys].sort(), ['L01_05|L02_11']);
  } finally {
    await cleanup();
  }
});

test('syncFares stores null for no-fare and for pairs that exhaust retries', async () => {
  const { dataDir, cleanup } = await makeCtx(
    [
      { id: 's-a', name: '甲' },
      { id: 's-b', name: '乙' },
      { id: 's-c', name: '丙' }
    ],
    []
  );
  try {
    let transientCalls = 0;
    // 甲-乙: planner says "no published fare" (permanent); 甲-丙: transient,
    // exhausts retries; 乙-丙 succeeds.
    await syncFares(
      { dataDir },
      {
        networkId: 'test',
        currency: 'CNY',
        unit: 'yuan',
        source: { name: 'test' },
        keyOf: (station) => station.name,
        query: async (a, b) => {
          if (a === '甲' && b === '乙') return { price: null, retry: false };
          if (a === '甲' && b === '丙') {
            transientCalls++;
            return { price: null, retry: true };
          }
          return { price: 5, retry: false };
        }
      }
    );

    const doc = JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8'));
    const iA = doc.station_ids.indexOf('s-a');
    const iB = doc.station_ids.indexOf('s-b');
    const iC = doc.station_ids.indexOf('s-c');
    assert.equal(doc.fares[iA][iB], null);
    assert.equal(doc.fares[iA][iC], null);
    assert.equal(doc.fares[iB][iC], 5);
    // Retry budget is RETRY_BACKOFF_MS.length attempts per pair.
    assert.equal(transientCalls, 3);
  } finally {
    await cleanup();
  }
});
