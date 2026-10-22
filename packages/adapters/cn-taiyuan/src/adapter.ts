import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { createTaiyuanFareSpec, loadTaiyuanPlannerKeys } from './fares.js';
import { runTaiyuanNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-taiyuan',
  displayName: { zh: '太原', en: 'Taiyuan' },
  layers: {
    // Official site publishes the full topology + first/last trains; the
    // operator's route planner adds per-hop run times, distances and geometry.
    topology: { supported: true, estimatedMinutes: 10 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // One planner query per OD pair (46 stations → 1035 pairs).
    fares: { supported: true, estimatedMinutes: 60 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // In-station transfer walks (大南门) are measured by the core Baidu harvest.
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-taiyuan');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runTaiyuanNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      const plannerByPoiid = await loadTaiyuanPlannerKeys(ctx.dataDir);
      const spec = createTaiyuanFareSpec(plannerByPoiid);
      await syncFares({ dataDir: ctx.dataDir }, spec, { concurrency: 6, delay: 60 });
    }
  }
};

export default adapter;
