import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runXuzhouFares, runXuzhouNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-xuzhou',
  displayName: { zh: '徐州', en: 'Xuzhou' },
  layers: {
    // Official xzdtjt.com dropBox tree (lines / station order / exits) + AMap
    // Subway 3203 for GCJ-02 coordinates, English names, line colours and the
    // schematic grid.
    topology: { supported: true, estimatedMinutes: 12 },
    // Per-station first/last trains from the operator's own timetable sheet
    // (`/1/54/timetable`), published as an HTML table.
    timetables: { supported: true, estimatedMinutes: 5 },
    // Official station-to-station fare matrix from the operator's route planner
    // (`/1/53/lineSearch`) — the operator prices on its own shortest-path
    // mileage, so the matrix is harvested rather than derived.
    fares: { supported: true, estimatedMinutes: 45 },
    // English names (AMap `multilang.n.en`, Wikidata as a safety net) and city
    // metadata.
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / distances / transfer
    // walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-xuzhou');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runXuzhouNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only sync keys on the existing stations.json and re-reads the
      // operator's station-id tree to rebuild the planner references.
      await runXuzhouFares({ root });
    }
  }
};

export default adapter;
