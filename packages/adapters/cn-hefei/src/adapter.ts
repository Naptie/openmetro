import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runHefeiNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-hefei',
  displayName: { zh: '合肥', en: 'Hefei' },
  layers: {
    // Topology from the AMap subway dataset (8 lines, 215 line-stop rows, 195
    // stations — 100 % coordinates, English names and schematic pixels), with
    // the operator's official 《首末班车时间及行车间隔》 on the Hefei government
    // disclosure platform supplying the service directions and the three
    // not-yet-open stations the official network map marks 暂未开通.
    topology: { supported: true, estimatedMinutes: 5 },
    // The official table publishes first/last trains for the lines' first-train
    // origin and last-train terminals across three service-day bands
    // (周一至周四工作日 / 周五工作日 / 双休日); the intermediate stations are
    // completed from the Baidu planner, which matches the official table
    // exactly at every published terminal.
    timetables: { supported: true, estimatedMinutes: 10 },
    // The operator publishes one distance ladder
    // (《合肥轨道票价信息及优惠政策》), so the OD matrix is computed
    // deterministically from the shortest rail distance once the segment
    // distances exist — it must run after the `gapfill` layer.
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / distances / transfer
    // walks) — the operator publishes none of the three.
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-hefei');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runHefeiNormalize({ root, skipGeocode: false, skipFares: !wantFares });
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
