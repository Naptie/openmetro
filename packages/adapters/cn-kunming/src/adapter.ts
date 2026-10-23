import { type AdapterManifest, repoRootForDataDir } from '@openmetro/core';

import { computeAndWriteFares } from './fares.js';
import { runKunmingNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-kunming',
  displayName: { zh: '昆明', en: 'Kunming' },
  layers: {
    // AMap subway dataset + AMap metro planner harvest.
    topology: { supported: true, estimatedMinutes: 8 },
    // The planner answers first/last trains for every station × pattern ×
    // direction in the same pass as the segment metrics.
    timetables: { supported: true, estimatedMinutes: 10 },
    // Official distance ladder over planner-measured mileage — no OD sweep.
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Transfer walks are not published by the operator; the core gapfill
    // layer measures them with the Baidu planner.
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers, ctx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-kunming');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runKunmingNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
