import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runGuangzhouNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-guangzhou',
  displayName: { zh: '广州', en: 'Guangzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 5 },
    fares: { supported: true, estimatedMinutes: 90 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runGuangzhouNormalize({ root: repoRootForDataDir(ctx.dataDir, 'cn-guangzhou') });
    }
    if (layers.includes('fares')) {
      await syncFares(ctx, fareSpec);
    }
  }
};

export default adapter;
