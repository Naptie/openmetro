import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runNanningNormalize, writeNanningFares } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-nanning',
  displayName: { zh: '南宁', en: 'Nanning' },
  layers: {
    // Official topology and the per-station detail blocks (exits, transfer
    // notes, descriptions) from the operator's server-rendered 地铁服务 page,
    // plus AMap coordinates / station codes / schematic / English names.
    topology: { supported: true, estimatedMinutes: 15 },
    // Per-station first/last trains via Baidu Direction v2 — the operator
    // publishes its timetable sheets only as static images (no OCR).
    timetables: { supported: true, estimatedMinutes: 30 },
    // OD fares: the planner's own quote per pair, with the operator's published
    // mileage tariff as the fallback for the pairs it cannot route rail-only.
    fares: { supported: true, estimatedMinutes: 60 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment distances / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-nanning');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runNanningNormalize({ root, skipFares: !wantFares });
      return;
    }

    if (wantFares) {
      // Fares-only sync: the matrix only needs the station ids already on disk
      // and their coordinates, so nothing else is re-harvested.
      await writeNanningFares(ctx.dataDir);
    }
  }
};

export default adapter;
