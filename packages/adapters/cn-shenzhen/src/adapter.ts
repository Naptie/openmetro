import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runShenzhenNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-shenzhen$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-shenzhen',
  displayName: { zh: '深圳', en: 'Shenzhen' },
  layers: {
    topology: { supported: true, estimatedMinutes: 12 },
    timetables: { supported: true, estimatedMinutes: 4 },
    // Official MinTimeJson per OD pair; monthly full-matrix harvest.
    fares: { supported: true, estimatedMinutes: 20 },
    enrichment: { supported: true, estimatedMinutes: 8 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runShenzhenNormalize({
        root,
        skipGeocode: false,
        skipPlannerTimes: false,
        skipFares: !wantFares,
        skipEnTimetables: true,
        skipZdxxTimetables: false
      });
    } else if (wantFares) {
      // Fares-only must never rewrite topology/timetables/planner times.
      await syncFares({ dataDir: ctx.dataDir }, fareSpec, { concurrency: 8, delay: 80 });
    }
  }
};

export default adapter;
