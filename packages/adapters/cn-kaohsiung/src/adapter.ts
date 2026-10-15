import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AdapterManifest,
  adapterCacheDir,
  repoRootForDataDir,
  writeCanonical
} from '@openmetro/core';
import { fetchKaohsiung, ORIGIN, PHOTON } from './fetch.js';
import { normalizeKaohsiung, retainFares } from './normalize.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-kaohsiung',
  displayName: { zh: '高雄', en: 'Kaohsiung' },
  layers: {
    topology: { supported: true, estimatedMinutes: 4 },
    timetables: { supported: true, estimatedMinutes: 4 },
    fares: { supported: true, estimatedMinutes: 15 },
    enrichment: { supported: true, estimatedMinutes: 4 },
    gapfill: { supported: false, estimatedMinutes: 0 }
  },
  async sync(layers, ctx) {
    if (!layers.length) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-kaohsiung');
    const data = normalizeKaohsiung(
      await fetchKaohsiung({
        fares: layers.includes('fares'),
        cacheDir: adapterCacheDir('cn-kaohsiung', root)
      })
    );
    // A weekly topology refresh must retain the monthly/opt-in fare harvest.
    // sync.ts reconciles the station index after this write.
    let previousFares: typeof data.fares | undefined;
    if (!layers.includes('fares')) {
      try {
        const old = JSON.parse(
          await readFile(join(ctx.dataDir, 'fares.json'), 'utf8')
        ) as typeof data.fares;
        previousFares = old;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const now = new Date().toISOString();
    const sources = [
      {
        name: 'krtc-planner',
        url: ORIGIN,
        version: 'live',
        retrieved_at: now,
        license: 'unknown',
        license_url: null,
        attribution: '高雄捷運股份有限公司；官方車站導覽、首末班車、站間行駛時間及單程票票價查詢。',
        notes: 'Planner results use a 24-hour scratch cache. Cross-system fares are unavailable.'
      },
      {
        name: 'photon-osm',
        url: PHOTON,
        version: 'live',
        retrieved_at: now,
        license: 'odbl',
        license_url: 'https://www.openstreetmap.org/copyright',
        attribution: '© OpenStreetMap contributors; geocoding by Photon / komoot.',
        notes: 'OSM rail POIs matched automatically by name and city; coordinates are derived.'
      }
    ];
    const operatorSources = [
      ['krtc-stations', '/Guide/station_guide'],
      ['krtc-lrt-stations', '/KLRT/station_guide'],
      ['krtc-timetables', '/Guide/first_and_last_train'],
      ['krtc-lrt-timetables', '/KLRT/first_and_last_train'],
      ['krtc-lrt-travel-matrix', '/KLRT/time_between_train']
    ].map(([name, path]) => ({ ...sources[0]!, name: name!, url: `${ORIGIN}${path}` }));
    data.fares.source = [sources[0]!] as typeof data.fares.source;
    if (previousFares) data.fares = retainFares(data.fares, previousFares) as typeof data.fares;
    if (layers.every((l) => l === 'fares')) {
      await writeFile(join(ctx.dataDir, 'fares.json'), JSON.stringify(data.fares, null, 2));
      return;
    }
    await writeCanonical(ctx.dataDir, 'cn-kaohsiung', data);
    for (const name of [
      'lines',
      'stations',
      'stops',
      'patterns',
      'segments',
      'transfers',
      'timetables'
    ]) {
      const path = join(ctx.dataDir, `${name}.json`);
      const doc = JSON.parse(await readFile(path, 'utf8'));
      doc.source = [...operatorSources, ...sources];
      await writeFile(path, JSON.stringify(doc, null, 2));
    }
  }
};
export default adapter;
