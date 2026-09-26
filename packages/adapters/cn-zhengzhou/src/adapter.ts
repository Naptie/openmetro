import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { findRepoRoot, networkDataDir, repoRootForDataDir } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runZhengzhouNormalize } from './run.js';


export const adapter: AdapterManifest = {
  networkId: 'cn-zhengzhou',
  displayName: { zh: '郑州', en: 'Zhengzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 10 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // Per-OD official trip planner; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-zhengzhou');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runZhengzhouNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
    }
  }
};

export default adapter;
