import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runFuzhouNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-fuzhou',
  displayName: { zh: '福州', en: 'Fuzhou' },
  layers: {
    // Official /services/schedule island props + AMap coordinates.
    topology: { supported: true, estimatedMinutes: 5 },
    // First/last trains ship with the same official feed (no Baidu needed).
    timetables: { supported: true, estimatedMinutes: 5 },
    // Official precomputed OD table via /api/system/way/list (~5k pairs).
    fares: { supported: true, estimatedMinutes: 15 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 20 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-fuzhou');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runFuzhouNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json.
      await syncFares(ctx, fareSpec, { concurrency: 8, delay: 100 });
    }
  }
};

export default adapter;
