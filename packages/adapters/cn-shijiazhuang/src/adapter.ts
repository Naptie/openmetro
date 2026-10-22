import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runShijiazhuangNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-shijiazhuang',
  displayName: { zh: '石家庄', en: 'Shijiazhuang' },
  layers: {
    // Official /metro API topology + AMap coordinates/English names.
    topology: { supported: true, estimatedMinutes: 8 },
    // Per-station first/last trains via Baidu Direction v2 (OPENMETRO_BAIDU_AK).
    timetables: { supported: true, estimatedMinutes: 12 },
    // Official tariff over planner-measured shortest-path mileage + drift check.
    fares: { supported: true, estimatedMinutes: 20 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-shijiazhuang');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runShijiazhuangNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json / segments.json.
      const ak = loadBaiduAk();
      await computeAndWriteFares(ctx.dataDir, ak ?? undefined);
    }
  }
};

export default adapter;
