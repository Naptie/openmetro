import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runGuangzhouNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-gz$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-gz',
  displayName: { zh: '广州', en: 'Guangzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 5 },
    fares: { supported: true, estimatedMinutes: 90 },
    enrichment: { supported: true, estimatedMinutes: 5 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runGuangzhouNormalize({ root: rootOf(ctx.dataDir) });
    }
    if (layers.includes('fares')) {
      await syncFares(ctx, fareSpec);
    }
  }
};

export default adapter;
