import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runHangzhouNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-hangzhou$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-hangzhou',
  displayName: { zh: '杭州', en: 'Hangzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // Per-OD official ticket inquiry; matrix is hours, not minutes.
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runHangzhouNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 12, delay: 80 });
    }
  }
};

export default adapter;
