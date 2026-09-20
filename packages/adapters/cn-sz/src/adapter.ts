import { type AdapterManifest, type SyncCtx, type SyncLayer } from '@openmetro/core';
import { runSuzhouNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-sz$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-sz',
  displayName: { zh: '苏州', en: 'Suzhou' },
  layers: {
    topology: { supported: true, estimatedMinutes: 5 },
    timetables: { supported: true, estimatedMinutes: 3 },
    // One-to-all getTransTickets — far cheaper than per-OD planners.
    fares: { supported: true, estimatedMinutes: 15 },
    enrichment: { supported: true, estimatedMinutes: 8 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    await runSuzhouNormalize({
      root,
      // Fares layer only: reuse existing topology; skip geocode re-fetch.
      skipGeocode: !wantTopology,
      skipFares: !layers.includes('fares')
    });
  }
};

export default adapter;
