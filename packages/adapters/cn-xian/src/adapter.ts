import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { fareSpec, mergeOfficialFares, writeXianFormulaFares } from './fares.js';
import { runXianNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-xian',
  displayName: { zh: '西安', en: "Xi'an" },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 4 },
    // Official per-OD ticketPrice; formula bootstrap keeps the matrix complete.
    fares: { supported: true, estimatedMinutes: 90 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-xian');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runXianNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares,
        harvestOfficialFares: wantFares
      });
      return;
    }

    if (wantFares) {
      await writeXianFormulaFares(ctx.dataDir, { fillOnly: true });
      await mergeOfficialFares(ctx.dataDir, { concurrency: 8, delayMs: 100 });
    }
  }
};

export default adapter;
export { fareSpec };
