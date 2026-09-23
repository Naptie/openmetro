import type { AdapterManifest, SyncCtx, SyncLayer } from '@openmetro/core';
import { fetchMtrSources } from './fetch.js';
import { normalizeHongKong } from './normalize.js';
import { runHongKongNormalize } from './run.js';

function rootOf(dataDir: string): string {
  const m = dataDir.match(/^(.*?)[/\\]data[/\\]cn-hongkong$/);
  return m?.[1] || process.env.OPENMETRO_ROOT || process.cwd();
}

export const adapter: AdapterManifest = {
  networkId: 'cn-hongkong',
  displayName: { zh: '香港', en: 'Hong Kong' },
  layers: {
    topology: { supported: true, estimatedMinutes: 3 },
    // First/last trains from official service_hours_search.php.
    timetables: { supported: true, estimatedMinutes: 5 },
    // Full OD matrix is published as CSV — no per-pair planner harvest.
    fares: { supported: true, estimatedMinutes: 1 },
    enrichment: { supported: true, estimatedMinutes: 8 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = rootOf(ctx.dataDir);

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
