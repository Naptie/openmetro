import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { applyOfficialSegmentDistances, harvestOfficialSegmentDistances } from './distances.js';
import { fareSpec, writeChengduFormulaFares } from './fares.js';
import { fillFareGaps } from './fill-gaps.js';
import { runChengduNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-chengdu$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-chengdu',
  displayName: { zh: '成都', en: 'Chengdu' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 2 },
    // Per-OD official trip planner; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);
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
      if (wantFares) {
        await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
        const cache = await harvestOfficialSegmentDistances(ctx.dataDir);
        await applyOfficialSegmentDistances(ctx.dataDir, cache);
        await fillFareGaps(ctx.dataDir);
      }
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await writeChengduFormulaFares(ctx.dataDir);
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
      // Official planner path km → segments; fill unpublished ODs
      // (neighbor official mode, else formula on those km).
      const cache = await harvestOfficialSegmentDistances(ctx.dataDir);
      await applyOfficialSegmentDistances(ctx.dataDir, cache);
      await fillFareGaps(ctx.dataDir);
    }
  }
};

export default adapter;
