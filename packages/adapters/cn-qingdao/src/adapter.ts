import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runQingdaoFares, runQingdaoNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-qingdao',
  displayName: { zh: '青岛', en: 'Qingdao' },
  layers: {
    // AMap topology cross-checked against the official siteSearch station
    // lists; the official site DB carries no coordinates, so AMap locations.
    topology: { supported: true, estimatedMinutes: 6 },
    // First/last trains via Baidu Direction Lite (OPENMETRO_BAIDU_AK). Live
    // query, no cache — the operator publishes timetables only as images.
    timetables: { supported: true, estimatedMinutes: 12 },
    // Whole-network matrix from the official published Excel workbook plus a
    // handful of live pjSearch validations; no per-OD planner sweep, so the
    // matrix is minutes, not hours.
    fares: { supported: true, estimatedMinutes: 3 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-qingdao');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runQingdaoNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only: workbook download + pjSearch validation + re-key onto the
      // existing stations.json. No planner harvest, no canonical rewrite.
      await runQingdaoFares(ctx.dataDir);
    }
  }
};

export default adapter;
