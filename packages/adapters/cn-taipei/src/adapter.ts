import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';
import { runTaipeiNormalize } from './run.js';
export const adapter: AdapterManifest = {
  networkId: 'cn-taipei',
  displayName: { zh: '台北都会区', en: 'Taipei Metropolitan MRT' },
  layers: {
    topology: { supported: true },
    timetables: { supported: true },
    fares: { supported: true },
    enrichment: { supported: true },
    gapfill: { supported: false }
  },
  async sync(layers, ctx) {
    // Refresh all three sources together so the merged references remain coherent.
    if (layers.length)
      await runTaipeiNormalize(repoRootForDataDir(ctx.dataDir, 'cn-taipei'), ctx.dataDir);
  }
};
export default adapter;
