/**
 * Sync canonical metro data for discovered adapters, fetching official
 * sources live.
 *
 *   bun run data:sync --list
 *   bun run data:sync --network cn-sh --layer topology,timetables,enrichment
 *   bun run data:sync --layer fares
 *
 * Layers:
 *   topology+timetables  weekly (official APIs)
 *   enrichment           rides with topology (coords / names)
 *   fares                monthly, **opt-in only** (per-adapter OD planners)
 *
 * Fares are never part of the default `--layer` set: the operator planners
 * are queried once per OD pair, which takes hours per network. They run only
 * when `fares` is named explicitly in `--layer` (see sync.yml: the weekly
 * cron omits it; the fares job is workflow_dispatch-only).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AdapterManifest,
  SYNC_LAYERS,
  type SyncCtx,
  type SyncLayer
} from '../packages/core/src/index.js';
import { type DiscoveredAdapter, discoverAdapters } from './discover-adapters.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // PowerShell / bun run may turn `topology,timetables` into `topology timetables`.
  const layerRaw = get('--layer') ?? 'topology,timetables,enrichment';
  const layers = layerRaw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean) as SyncLayer[];
  for (const l of layers) {
    if (!SYNC_LAYERS.includes(l)) {
      throw new Error(`unknown layer ${l} (want ${SYNC_LAYERS.join('|')})`);
    }
  }
  const network = get('--network');
  const list = argv.includes('--list');
  return { layers, network, list };
}

async function loadManifest(adapter: DiscoveredAdapter): Promise<AdapterManifest> {
  const mod = await import(adapter.entry);
  const manifest: AdapterManifest | undefined = mod.adapter ?? mod.default;
  if (!manifest?.networkId) {
    throw new Error(`${adapter.name}: entry ${adapter.entry} does not export AdapterManifest`);
  }
  return manifest;
}

/**
 * Align fares.json with the current stations.json after a topology sync:
 * drop removed stations, append null rows/cols for new ones, keep known OD values.
 */
async function reconcileFares(networkId: string): Promise<void> {
  const dir = join(ROOT, 'data', networkId);
  const faresPath = join(dir, 'fares.json');
  const stationsPath = join(dir, 'stations.json');
  let faresDoc: {
    station_ids: string[];
    fares: (number | null)[][];
    generated_at?: string;
  };
  try {
    faresDoc = JSON.parse(await readFile(faresPath, 'utf-8'));
  } catch {
    return; // no fares layer for this network
  }
  const stations = (
    JSON.parse(await readFile(stationsPath, 'utf-8')).records as { id: string }[]
  ).map((s) => s.id);
  const oldIds = faresDoc.station_ids;
  if (oldIds.length === stations.length && oldIds.every((id, i) => id === stations[i])) {
    return;
  }
  const idx = new Map(oldIds.map((id, i) => [id, i]));
  const n = stations.length;
  const next: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );
  for (let i = 0; i < n; i++) {
    const oi = idx.get(stations[i]);
    if (oi == null) continue;
    for (let j = 0; j < n; j++) {
      const oj = idx.get(stations[j]);
      if (oj == null) continue;
      const v = faresDoc.fares[oi]?.[oj];
      if (v != null) next[i][j] = v;
    }
  }
  faresDoc.station_ids = stations;
  faresDoc.fares = next;
  faresDoc.generated_at = new Date().toISOString();
  await writeFile(faresPath, `${JSON.stringify(faresDoc)}\n`, 'utf-8');
  console.log(`[${networkId}] reconciled fares: ${oldIds.length}x${oldIds.length} -> ${n}x${n}`);
}

async function main() {
  const args = parseArgs();
  let adapters = await discoverAdapters();
  if (args.network && args.network !== 'all') {
    adapters = adapters.filter((a) => a.networkId === args.network);
  }
  if (adapters.length === 0) {
    console.error('no matching adapters');
    process.exit(1);
  }

  if (args.list) {
    for (const a of adapters) {
      const m = await loadManifest(a);
      const supported = SYNC_LAYERS.filter((l) => m.layers[l]?.supported);
      console.log(`${m.networkId}\t${m.displayName.en}\tlayers=${supported.join(',')}`);
    }
    return;
  }

  const failed: string[] = [];

  // Fares are opt-in only (see header): reaching this point means `fares` was
  // named explicitly in --layer, so flag the expected runtime cost.
  if (args.layers.includes('fares')) {
    console.log(
      'note: fares layer requested — the operator planner is queried once per OD ' +
        'pair, which can take hours per network'
    );
  }

  for (const a of adapters) {
    const manifest = await loadManifest(a);
    const dataDir = join(ROOT, 'data', manifest.networkId);
    const ctx: SyncCtx = { dataDir };

    const wanted = args.layers.filter((l) => manifest.layers[l]?.supported);
    const skip = args.layers.filter((l) => !manifest.layers[l]?.supported);
    if (skip.length > 0) {
      console.log(`[${manifest.networkId}] skip unsupported layers: ${skip.join(',')}`);
    }

    try {
      if (wanted.length > 0) {
        console.log(`[${manifest.networkId}] sync ${wanted.join(',')}`);
        await manifest.sync(wanted, ctx);
        // Topology may add/remove stations; keep fare matrix index consistent.
        if (wanted.some((l) => l === 'topology')) {
          await reconcileFares(manifest.networkId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${manifest.networkId}] FAILED: ${msg}`);
      failed.push(manifest.networkId);
    }
  }

  if (failed.length > 0) {
    console.error(`sync failed for: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('sync complete');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
