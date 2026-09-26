import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { findRepoRoot, networkDataDir, repoRootForDataDir } from '@openmetro/core';
import {
  applyOfficialSegmentDistances,
  harvestOfficialSegmentDistances,
  triangulateJunctionEdges
} from './distances.js';
import { fareSpec, writeChengduFormulaFares } from './fares.js';
import { fillFareGaps } from './fill-gaps.js';
import { runChengduNormalize } from './run.js';


export const adapter: AdapterManifest = {
  networkId: 'cn-chengdu',
  displayName: { zh: '成都', en: 'Chengdu' },
  layers: {
    topology: { supported: true, estimatedMinutes: 10 },
    timetables: { supported: true, estimatedMinutes: 2 },
    // Per-OD official trip planner; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-chengdu');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runChengduNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares,
        // Topology rebuilds rewrite stations.json; re-seed the formula matrix
        // so a complete network still ships fares before the OD harvest.
        skipFormulaFares: false
      });
      // Segment km: one getTravel.dis per undirected adjacent pair (~458),
      // not the full OD fare matrix. Same layer as other adapters' planner
      // hop harvest (Shenzhen MinTimeJson, Shanghai plantrip) — topology.
      const cache = await harvestOfficialSegmentDistances(ctx.dataDir);
      await applyOfficialSegmentDistances(ctx.dataDir, cache);
      // 新业路 cannot be a planner OD endpoint: recover its three edges from
      // through-path dis between neighbours.
      await triangulateJunctionEdges(ctx.dataDir, 'cn-chengdu-xinye-road', {
        'cn-chengdu-chengdu-jincheng-college|cn-chengdu-baiye-road': 2056,
        'cn-chengdu-chengdu-jincheng-college|cn-chengdu-tulong-road': 2487,
        'cn-chengdu-baiye-road|cn-chengdu-tulong-road': 2703
      });
      if (wantFares) {
        await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
        await fillFareGaps(ctx.dataDir);
      }
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables/segment km.
      await writeChengduFormulaFares(ctx.dataDir);
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
      await fillFareGaps(ctx.dataDir);
    }
  }
};

export default adapter;
