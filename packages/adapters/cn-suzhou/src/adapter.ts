import type { AdapterManifest, SyncCtx, SyncLayer } from '@openmetro/core';
import { harvestSuzhouFares } from './fares.js';
import { runSuzhouNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-suzhou$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-suzhou',
  displayName: { zh: '苏州', en: 'Suzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // One-to-all getTransTickets — cheap enough to bundle with every full sync.
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 8 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);

    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runSuzhouNormalize({ root });
      return;
    }

    if (layers.includes('fares')) {
      // Fares-only: one-to-all harvest; keep topology on disk.
      await harvestSuzhouFares(ctx.dataDir);
    }
  }
};

export default adapter;
