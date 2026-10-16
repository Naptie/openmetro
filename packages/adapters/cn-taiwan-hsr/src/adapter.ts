import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';
import { runThsrNormalize } from './run.js';
export const adapter: AdapterManifest = {
  networkId: 'cn-taiwan-hsr',
  displayName: { zh: '台湾高铁', en: 'Taiwan High Speed Rail' },
  layers: {
    topology: { supported: true },
    timetables: { supported: true },
    fares: { supported: true },
    enrichment: { supported: true },
    gapfill: { supported: false }
  },
  async sync(layers, ctx) {
    if (layers.some((layer) => layer !== 'gapfill'))
      await runThsrNormalize(repoRootForDataDir(ctx.dataDir, 'cn-taiwan-hsr'), ctx.dataDir);
  }
};
export default adapter;
