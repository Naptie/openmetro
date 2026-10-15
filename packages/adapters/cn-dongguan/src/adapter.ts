import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';
import { syncDongguanFares } from './fares.js';
import { runDongguanNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-dongguan',
  displayName: { zh: '东莞', en: 'Dongguan' },
  layers: {
    topology: { supported: true, estimatedMinutes: 1 },
    timetables: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 1 },
    fares: { supported: true, estimatedMinutes: 2 },
    gapfill: { supported: true, estimatedMinutes: 5 }
  },
  async sync(layers, ctx) {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runDongguanNormalize({
        root: repoRootForDataDir(ctx.dataDir, 'cn-dongguan'),
        fares: layers.includes('fares')
      });
    } else if (layers.includes('fares')) {
      await syncDongguanFares(ctx.dataDir);
    }
  }
};

export default adapter;
