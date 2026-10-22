import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runHohhotNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-hohhot',
  displayName: { zh: '呼和浩特', en: 'Hohhot' },
  layers: {
    // AMap topology + Baidu planner first/last trains.
    topology: { supported: true, estimatedMinutes: 8 },
    // First/last trains via Baidu Direction v2, cross-checked against the
    // operator's published 首末班车时刻表 (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 8 },
    // Per-OD planner fare quotes (43 stations → 903 pairs, ~5 minutes).
    fares: { supported: true, estimatedMinutes: 6 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-hohhot');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runHohhotNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for planner fare quotes');
      await computeAndWriteFares(ctx.dataDir, ak);
    }
  }
};

export default adapter;
