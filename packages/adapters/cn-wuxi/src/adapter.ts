import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runWuxiNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-wuxi',
  displayName: { zh: '无锡', en: 'Wuxi' },
  layers: {
    // Topology from the AMap subway dataset (5 lines, 97 line-stop rows, 89
    // stations — 100 % coordinates, real English names and schematic pixels),
    // with the operator's official network map supplying the not-yet-open
    // stations (安镇) and the official English names.
    topology: { supported: true, estimatedMinutes: 5 },
    // Per-station first/last trains from the Baidu planner (direction/v2/transit
    // exposes the boarding station's service window). The operator publishes
    // its timetable sheets only as images, so there is nothing to parse
    // directly; the harvest was verified against the official 4 号线 sheet —
    // 66/66 comparable cells within ±2 minutes, 33 of them exact.
    timetables: { supported: true, estimatedMinutes: 12 },
    // The operator publishes one mileage tariff (《无锡地铁票务规则》第二条),
    // so the OD matrix is computed deterministically from the shortest rail
    // distance — it must run **after** the `gapfill` layer, which supplies the
    // segment kilometre measurements.
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / distances / transfer
    // walks) — the operator publishes none of the three.
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-wuxi');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      // The fare matrix is **not** computed here: the tariff is distance-based
      // and the distances arrive with the `gapfill` layer. Run
      //   data:sync --layer topology,timetables,enrichment
      //   data:sync --layer gapfill
      //   data:sync --layer fares
      // in that order.
      await runWuxiNormalize({ root });
      return;
    }

    if (wantFares) {
      // Fares-only: recompute the ladder on the segment distances already on
      // disk. No planner harvest, no canonical rewrite.
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
