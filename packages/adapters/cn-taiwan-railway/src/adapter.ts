import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';
import { runTraNormalize } from './run.js';
export const adapter: AdapterManifest = {
  networkId: 'cn-taiwan-railway',
  displayName: { zh: '台铁', en: 'Taiwan Railway' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    timetables: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true },
    fares: { supported: false },
    gapfill: { supported: false }
  },
  async sync(layers, ctx) {
    if (
      layers.some(
        (layer) => layer === 'topology' || layer === 'timetables' || layer === 'enrichment'
      )
    )
      await runTraNormalize(repoRootForDataDir(ctx.dataDir, 'cn-taiwan-railway'), ctx.dataDir);
  }
};
export default adapter;
