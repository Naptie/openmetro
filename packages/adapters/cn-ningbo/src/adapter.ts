import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer,
  syncFares
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runNingboNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-ningbo',
  displayName: { zh: '宁波', en: 'Ningbo' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // Official per-OD route/fare query; 179 stations => ~16k pairs, minutes.
    fares: { supported: true, estimatedMinutes: 15 },
    enrichment: { supported: true, estimatedMinutes: 6 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-ningbo');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runNingboNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
    }
  }
};

export default adapter;
