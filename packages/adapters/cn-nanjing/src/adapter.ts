import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { findRepoRoot, networkDataDir, repoRootForDataDir } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runNanjingNormalize } from './run.js';


export const adapter: AdapterManifest = {
  networkId: 'cn-nanjing',
  displayName: { zh: '南京', en: 'Nanjing' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    // First/last trains via Baidu Direction Lite (OPENMETRO_BAIDU_AK). Live query, no cache.
    timetables: { supported: true, estimatedMinutes: 8 },
    // Per-OD getPrice.do; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-nanjing');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runNanjingNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 10, delay: 100 });
    }
  }
};

export default adapter;
