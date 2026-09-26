import type { AdapterManifest, SyncCtx, SyncLayer } from '@openmetro/core';
import { repoRootForDataDir } from '@openmetro/core';
import { fetchMtrSources } from './fetch.js';
import { normalizeHongKong } from './normalize.js';
import { runHongKongNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-hongkong',
  displayName: { zh: '香港', en: 'Hong Kong' },
  layers: {
    topology: { supported: true, estimatedMinutes: 3 },
    // First/last trains from official service_hours_search.php.
    timetables: { supported: true, estimatedMinutes: 5 },
    // Full OD matrix is published as CSV — no per-pair planner harvest.
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 8 },
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-hongkong');

    if (layers.some((l) => l === 'topology' || l === 'timetables' || l === 'enrichment')) {
      await runHongKongNormalize({ root });
      return;
    }

    if (layers.includes('fares')) {
      // Fares-only: rewrite the matrix from published CSVs; keep topology on disk.
      const sources = await fetchMtrSources();
      const canonical = normalizeHongKong(sources);
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
