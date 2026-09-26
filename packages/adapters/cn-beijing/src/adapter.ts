import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runBeijingNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-beijing',
  displayName: { zh: '北京', en: 'Beijing' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    // Segment times come from beijing.xml; timetables are first/last trains only.
    timetables: { supported: true, estimatedMinutes: 2 },
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runBeijingNormalize({ root: repoRootForDataDir(ctx.dataDir, 'cn-beijing') });
    }
    if (layers.includes('fares')) {
      await syncFares(ctx, fareSpec);
    }
  }
};

export default adapter;
