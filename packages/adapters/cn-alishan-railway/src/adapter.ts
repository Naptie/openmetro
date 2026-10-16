import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';
import { runAlishanNormalize } from './run.js';
export const adapter: AdapterManifest = {
  networkId: 'cn-alishan-railway',
  displayName: { zh: '阿里山森林铁路', en: 'Alishan Forest Railway' },
  layers: {
    topology: { supported: true },
    timetables: { supported: true },
    fares: { supported: true },
    enrichment: { supported: true },
    gapfill: { supported: false }
  },
  async sync(layers, ctx) {
    if (layers.some((layer) => layer !== 'gapfill'))
      await runAlishanNormalize(repoRootForDataDir(ctx.dataDir, 'cn-alishan-railway'), ctx.dataDir);
  }
};
export default adapter;
