import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AdapterManifest, writeCanonical } from '@openmetro/core';
import { fetchTaichung, SOURCES } from './fetch.js';
import { normalizeTaichung } from './normalize.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-taichung',
  displayName: { zh: '台中', en: 'Taichung' },
  layers: {
    topology: { supported: true, estimatedMinutes: 1 },
    timetables: { supported: true, estimatedMinutes: 1 },
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 1 },
    gapfill: { supported: false, estimatedMinutes: 0 }
  },
  async sync(layers, ctx) {
    if (!layers.length) return;
    const data = normalizeTaichung(await fetchTaichung());
    const sources = Object.entries(SOURCES).map(([name, url]) => ({
      name: `tmrt-${name}`,
      url,
      version: 'live',
      retrieved_at: new Date().toISOString(),
      license: ['officialStations', 'timetables'].includes(name) ? 'unknown' : 'custom',
      license_url: ['officialStations', 'timetables'].includes(name)
        ? null
        : 'https://data.gov.tw/license',
      attribution: ['officialStations', 'timetables'].includes(name)
        ? '臺中捷運股份有限公司；官方車站、現行首末班車及乘車時間。'
        : '提供機關／臺中捷運股份有限公司：臺中捷運綠線車站資訊、站間票價、站間行車時間及首末班車時刻表。此開放資料依政府資料開放授權條款第1版釋出。',
      notes: 'Operator station identity from tmrt.com.tw; open datasets published under OGDL-1.0.'
    }));
    data.fares.source = sources as typeof data.fares.source;
    if (layers.every((l) => l === 'fares')) {
      await mkdir(ctx.dataDir, { recursive: true });
      await writeFile(join(ctx.dataDir, 'fares.json'), JSON.stringify(data.fares, null, 2));
      return;
    }
    await writeCanonical(ctx.dataDir, 'cn-taichung', data);
    for (const name of [
      'lines',
      'stations',
      'stops',
      'patterns',
      'segments',
      'transfers',
      'timetables'
    ]) {
      const file = join(ctx.dataDir, `${name}.json`);
      const doc = JSON.parse(await readFile(file, 'utf8'));
      doc.source = sources;
      await writeFile(file, JSON.stringify(doc, null, 2));
    }
  }
};
export default adapter;
