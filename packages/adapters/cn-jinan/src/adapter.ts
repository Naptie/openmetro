import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares, harvestAndApplySegmentDistances } from './fares.js';
import { runJinanNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-jinan',
  displayName: { zh: '济南', en: 'Jinan' },
  layers: {
    // AMap topology + Baidu Direction Lite timetables + planner segment km.
    topology: { supported: true, estimatedMinutes: 8 },
    // First/last trains via Baidu Direction Lite (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 10 },
    // Computed from the official mileage tariff over harvested segment km;
    // no per-OD planner queries, so the matrix is minutes, not hours.
    fares: { supported: true, estimatedMinutes: 3 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-jinan');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runJinanNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only must still see fresh segment km when the topology layer
      // has never harvested them; the distance cache makes the re-harvest a
      // no-op after the first run.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for segment distances');
      await harvestAndApplySegmentDistances(ctx.dataDir, ak);
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
