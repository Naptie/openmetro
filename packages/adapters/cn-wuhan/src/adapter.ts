import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runWuhanNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-wuhan',
  displayName: { zh: '武汉', en: 'Wuhan' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 4 },
    // Per-OD official route planner; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 8 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-wuhan');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runWuhanNormalize({
        root,
        skipGeocode: false,
        skipPlannerTimes: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables/planner times.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
    }
  }
};

export default adapter;
