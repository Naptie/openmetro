import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runChangchunNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-changchun',
  displayName: { zh: '长春', en: 'Changchun' },
  layers: {
    // Official POST /api/v1/getLines (topology, stop codes, interchange map,
    // per-station first/last trains) + AMap Subway 2201 (coordinates, English
    // names, schematic pixels, line colours).
    topology: { supported: true, estimatedMinutes: 5 },
    // First/last trains via Baidu Direction v2 (OPENMETRO_BAIDU_AK). The
    // operator publishes its timetables only as images on /1hx4…/8hx4; no OCR
    // path. Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 15 },
    // Official distance ladder over the planner's in-vehicle mileage
    // (the operator's own fare planner endpoint returns empty for every
    // parameter form).
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-changchun');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runChangchunNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only: recompute the ladder on the segment distances already on
      // disk. No planner harvest, no canonical rewrite.
      const { computeAndWriteFares } = await import('./fares.js');
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
