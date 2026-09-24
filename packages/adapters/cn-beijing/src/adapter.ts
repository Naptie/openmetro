import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runBeijingNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-beijing$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-beijing',
  displayName: { zh: '北京', en: 'Beijing' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    // Segment times come from beijing.xml; timetables are first/last trains only.
    timetables: { supported: true, estimatedMinutes: 2 },
    fares: { supported: true, estimatedMinutes: 120 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runBeijingNormalize({ root: rootOf(ctx.dataDir) });
    }
    if (layers.includes('fares')) {
      await syncFares(ctx, fareSpec);
    }
  }
};

export default adapter;
