import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runNanchangNormalize, writeNanchangFares } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-nanchang',
  displayName: { zh: '南昌', en: 'Nanchang' },
  layers: {
    // Official topology from the operator's `AllLine` payload, plus AMap
    // coordinates / station codes / English names / schematic pixels.
    topology: { supported: true, estimatedMinutes: 8 },
    // Per-station first/last trains via Baidu Direction v2 (metro-first): the
    // operator publishes its timetable sheets only as static images (no OCR).
    timetables: { supported: true, estimatedMinutes: 20 },
    // The operator's own route planner quotes the OD fare — one query per pair.
    fares: { supported: true, estimatedMinutes: 60 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment distances / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-nanchang');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runNanchangNormalize({ root, skipFares: !wantFares });
      return;
    }

    if (wantFares) {
      // Fares-only sync: the matrix only needs the station ids already on disk
      // and the operator's line membership, so nothing else is re-harvested.
      await writeNanchangFares(ctx.dataDir);
    }
  }
};

export default adapter;
