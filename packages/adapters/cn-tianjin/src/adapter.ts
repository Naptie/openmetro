import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runTianjinNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-tianjin',
  displayName: { zh: '天津', en: 'Tianjin' },
  layers: {
    // AMap topology + the official tjgdjt H5 timetable (first/last trains are
    // embedded static data — no planner harvest needed).
    topology: { supported: true, estimatedMinutes: 5 },
    timetables: { supported: true, estimatedMinutes: 2 },
    // Interval-ladder network fares + ~135 coastal-segment planner quotes.
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 4 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 20 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-tianjin');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runTianjinNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for coastal fare quotes');
      await computeAndWriteFares(ctx.dataDir, ak);
    }
  }
};

export default adapter;
