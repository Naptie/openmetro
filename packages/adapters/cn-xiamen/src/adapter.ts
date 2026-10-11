import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runXiamenNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-xiamen',
  displayName: { zh: '厦门', en: 'Xiamen' },
  layers: {
    // AMap topology cross-checked against the official CMS line-station lists.
    topology: { supported: true, estimatedMinutes: 8 },
    // First/last trains: official CMS for lines 1–3, Baidu Direction Lite for
    // lines 4/6 and CMS gaps (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 10 },
    // Per-OD official fare inquiry (~70 numeric-id stations answer; UUID-id
    // stations fail fast), concurrency 12.
    fares: { supported: true, estimatedMinutes: 15 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-xiamen');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runXiamenNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 12, delay: 60 });
    }
  }
};

export default adapter;
