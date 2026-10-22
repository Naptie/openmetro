import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { writeLanzhouFaresFromDisk } from './fares.js';
import { fetchLanzhouSources } from './fetch.js';
import { runLanzhouNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-lanzhou',
  displayName: { zh: '兰州', en: 'Lanzhou' },
  layers: {
    // Official topology from the operator's `serve.js` production literal,
    // plus AMap coordinates / station codes / pinyin.
    topology: { supported: true, estimatedMinutes: 5 },
    // Per-station first/last trains via Baidu Direction v2 (metro-first): the
    // operator publishes its timetable sheets only as static images (no OCR).
    timetables: { supported: true, estimatedMinutes: 6 },
    // The operator publishes its complete OD fare matrix as a static asset —
    // no per-OD harvesting at all.
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-lanzhou');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runLanzhouNormalize({ root });
      return;
    }

    if (wantFares) {
      // Fares-only sync: the operator's matrix is static, so it only needs
      // the station ids already on disk.
      const sources = await fetchLanzhouSources();
      await writeLanzhouFaresFromDisk(ctx.dataDir, sources.officialFares);
    }
  }
};

export default adapter;
