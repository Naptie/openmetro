/**
 * Sync canonical metro data for discovered adapters, fetching official
 * sources live.
 *
 *   bun run data:sync --list
 *   bun run data:sync --network cn-shanghai --layer topology,timetables,enrichment
 *   bun run data:sync --layer fares
 *
 * Layers:
 *   topology+timetables  weekly (official APIs)
 *   enrichment           rides with topology (coords / names)
 *   fares                monthly, **opt-in only** (per-adapter OD planners)
 *   gapfill              **opt-in only** (adapter-agnostic Baidu planner
 *                        harvest of weak/missing segment times, distances
 *                        and transfer walks)
 *
 * Fares and gapfill are never part of the default `--layer` set: fares query
 * the operator planner once per OD pair (hours per network); gapfill queries
 * a third-party planner for residual edges. Both run only when named
 * explicitly in `--layer`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AdapterManifest,
  computeNetworkQuality,
  runGapfill,
  SYNC_LAYERS,
  type SyncCtx,
  type SyncLayer
} from '../packages/core/src/index.js';
import { type DiscoveredAdapter, discoverAdapters } from './discover-adapters.js';
import { writeQualityReport } from './write-quality-report.js';

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

/** Recompute `network.json.quality` from on-disk canonical records + fares. */
async function refreshNetworkQuality(networkId: string): Promise<void> {
  const dir = join(ROOT, 'data', networkId);
  const loadRecords = async (name: string) => {
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { records?: unknown[] };
      return doc.records ?? [];
    } catch {
      return [];
    }
  };
  const netPath = join(dir, 'network.json');
  const net = JSON.parse(await readFile(netPath, 'utf-8')) as Record<string, unknown>;
  let fares: unknown;
  try {
    fares = JSON.parse(await readFile(join(dir, 'fares.json'), 'utf-8'));
  } catch {
    fares = undefined;
  }
  const quality = computeNetworkQuality({
    lines: (await loadRecords('lines.json')) as { id: string }[],
    stations: (await loadRecords('stations.json')) as never,
    stops: (await loadRecords('stops.json')) as never,
    segments: (await loadRecords('segments.json')) as never,
    transfers: (await loadRecords('transfers.json')) as never,
    timetables: (await loadRecords('timetables.json')) as never,
    fares: fares as never
  });
  await writeFile(netPath, `${JSON.stringify({ ...net, quality }, null, 2)}\n`, 'utf-8');
  console.log(`[${networkId}] refreshed network quality`);
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
  if (args.layers.includes('gapfill')) {
    console.log(
      'note: gapfill layer requested — Baidu transit planner fills residual ' +
        'segment/transfer gaps (set OPENMETRO_BAIDU_AK)'
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
      // `gapfill` is core-orchestrated and adapter-agnostic: adapters only
      // declare `layers.gapfill.supported`; they never implement the harvest.
      const adapterLayers = wanted.filter((l) => l !== 'gapfill');
      const wantGapfill = wanted.includes('gapfill');
      if (adapterLayers.length > 0 || wantGapfill) {
        console.log(
          `[${manifest.networkId}] sync ${[...adapterLayers, ...(wantGapfill ? ['gapfill'] : [])].join(',')}`
        );
      }
      if (adapterLayers.length > 0) {
        await manifest.sync(adapterLayers, ctx);
        // Topology may add/remove stations; keep fare matrix index consistent.
        if (adapterLayers.some((l) => l === 'topology')) {
          await reconcileFares(manifest.networkId);
        }
        // Fares-only sync writes fares.json but does not touch network.json;
        // recompute quality so the report reflects the new matrix.
        if (adapterLayers.some((l) => l === 'fares')) {
          await refreshNetworkQuality(manifest.networkId);
        }
      }
      if (wantGapfill) {
        await runGapfill(ctx);
        await refreshNetworkQuality(manifest.networkId);
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
  try {
    const report = await writeQualityReport(ROOT);
    console.log(`quality report: ${report}`);
  } catch (err) {
    console.warn(`quality report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('sync complete');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
