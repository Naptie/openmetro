import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runHarbinNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-harbin',
  displayName: { zh: '哈尔滨', en: 'Harbin' },
  layers: {
    // AMap topology + Baidu Direction v2 first/last trains and segment metrics.
    topology: { supported: true, estimatedMinutes: 8 },
    // First/last trains via Baidu Direction v2 (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 12 },
    // Official mileage-tiered tariff over planner-measured in-vehicle distances.
    fares: { supported: true, estimatedMinutes: 3 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-harbin');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runHarbinNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing topology.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for the fare matrix');
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
