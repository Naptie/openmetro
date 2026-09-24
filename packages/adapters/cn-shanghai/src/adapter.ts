import { type AdapterManifest, type SyncCtx, type SyncLayer, syncFares } from '@openmetro/core';
import { fareSpec } from './fares.js';
import { runShanghaiNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-shanghai$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-shanghai',
  displayName: { zh: '上海', en: 'Shanghai' },
  layers: {
    topology: { supported: true, estimatedMinutes: 8 },
    timetables: { supported: true, estimatedMinutes: 3 },
    fares: { supported: true, estimatedMinutes: 90 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runShanghaiNormalize({ root: rootOf(ctx.dataDir) });
    }
    if (layers.includes('fares')) {
      await syncFares(ctx, fareSpec);
    }
  }
};

export default adapter;
