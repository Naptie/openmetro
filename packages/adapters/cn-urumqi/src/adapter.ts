import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runUrumqiNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-urumqi',
  displayName: { zh: '乌鲁木齐', en: 'Ürümqi' },
  layers: {
    // AMap topology + Baidu Direction v2 first/last trains + segment metrics.
    topology: { supported: true, estimatedMinutes: 8 },
    // First/last trains via Baidu Direction v2 (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 8 },
    // Per-OD planner fare quotes (~210 pairs, ~3 minutes at throttle).
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-urumqi');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runUrumqiNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for planner fare quotes');
      await computeAndWriteFares(ctx.dataDir, ak);
    }
  }
};

export default adapter;
