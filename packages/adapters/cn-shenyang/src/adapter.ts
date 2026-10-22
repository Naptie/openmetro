import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runShenyangNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-shenyang',
  displayName: { zh: '沈阳', en: 'Shenyang' },
  layers: {
    // Official cocc-website API: lines, per-line station order, official
    // per-line station codes, line colours, mileage and opening dates.
    topology: { supported: true, estimatedMinutes: 8 },
    // Official per-station, per-direction first/last trains
    // (getHomePageInitData.stationsList, POSTed — the GET variant of the
    // same endpoint serves a pre-东延线 snapshot).
    timetables: { supported: true, estimatedMinutes: 5 },
    // Official tariff over planner-measured shortest-path mileage, capped at
    // 7 yuan (《沈阳地铁票务规则》). The operator's mileage accounting sits a
    // few tens of metres below the planner's rail distance, so every pair whose
    // mileage lands near a tariff threshold is re-quoted with the operator —
    // that is ~1700 of the 10k pairs, which is what makes this layer slow.
    fares: { supported: true, estimatedMinutes: 70 },
    enrichment: { supported: true, estimatedMinutes: 8 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-shenyang');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runShenyangNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json / segments.json.
      const ak = loadBaiduAk();
      await computeAndWriteFares(ctx.dataDir, ak ?? undefined);
    }
  }
};

export default adapter;
