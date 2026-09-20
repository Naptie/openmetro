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
    // One-to-all getTransTickets — seconds, unlike per-OD planners in other cities.
    fares: { supported: true, estimatedMinutes: 5 },
    enrichment: { supported: true, estimatedMinutes: 8 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    // Always write fares.json: verify requires it for a complete network, and
    // Suzhou's one-to-all endpoint is cheap enough to run on every sync.
    await runSuzhouNormalize({
      root,
      skipGeocode: !wantTopology,
      skipFares: false
    });
  }
};

export default adapter;
