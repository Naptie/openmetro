import type { AdapterManifest, SyncCtx, SyncLayer } from '@openmetro/core';
import { repoRootForDataDir } from '@openmetro/core';
import { fetchMlmSources } from './fetch.js';
import { normalizeMacau } from './normalize.js';
import { runMacauNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-macau',
  displayName: { zh: '澳门', en: 'Macau' },
  layers: {
    topology: { supported: true, estimatedMinutes: 3 },
    // First/last from verified terminus sheets + derived runtimes (no Baidu —
    // Baidu Maps has no Macau LRT coverage).
    timetables: { supported: true, estimatedMinutes: 2 },
    // Station-count fare rules → full OD matrix (15 stations).
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    gapfill: { supported: false, estimatedMinutes: 0 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-macau');

    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runMacauNormalize({ root });
      return;
    }

    if (layers.includes('fares')) {
      const sources = await fetchMlmSources();
      const canonical = normalizeMacau(sources);
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(
        join(ctx.dataDir, 'fares.json'),
        `${JSON.stringify(canonical.fares, null, 2)}\n`,
        'utf-8'
      );
      console.log(`  wrote ${join(ctx.dataDir, 'fares.json')}`);
    }
  }
};

export default adapter;
