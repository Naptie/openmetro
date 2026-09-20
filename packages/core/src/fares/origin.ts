import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncCtx } from '../adapter/contract.js';
import { entitySchemaUrl } from '../schema/file.js';
import { type StationEncoded, isStationRoutable } from '../schema/index.js';

/**
 * City-agnostic fare harvest when the operator publishes **one origin → all
 * destinations** in a single response (cheaper than per-OD planners).
 * The adapter supplies only the origin fetch; matrix assembly is shared.
 */
export interface OriginFareSpec {
  networkId: string;
  currency: string;
  unit: string;
  source: Record<string, unknown>;
  keyOf: (station: StationEncoded, stopCode: (stationId: string) => string | undefined) => string;
  /**
   * Fetch every published fare from one origin key.
   * Return destKey → price (yuan). Missing dests stay null in the matrix.
   */
  queryAll: (originKey: string) => Promise<Map<string, number> | Record<string, number>>;
}

export interface OriginFareSyncOptions {
  concurrency?: number;
  delayMs?: number;
}

function toMap(prices: Map<string, number> | Record<string, number>): Map<string, number> {
  return prices instanceof Map ? prices : new Map(Object.entries(prices));
}

/**
 * Build a symmetric OD fare matrix from origin-wise bulk queries and write
 * `<ctx.dataDir>/fares.json`.
 *
 * Matrix index always covers every station in `stations.json` (so consumers
 * and data:verify see a complete station list). Only operating stations are
 * queried as origins; non-operating rows stay null except the zero diagonal.
 */
export async function syncFaresFromOrigins(
  ctx: SyncCtx,
  spec: OriginFareSpec,
  opts: OriginFareSyncOptions = {}
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const delayMs = opts.delayMs ?? 0;

  const stations = (
    JSON.parse(await readFile(join(ctx.dataDir, 'stations.json'), 'utf-8'))
      .records as StationEncoded[]
  ).sort((a, b) => a.id.localeCompare(b.id));

  const stops = JSON.parse(await readFile(join(ctx.dataDir, 'stops.json'), 'utf-8')).records as {
    station_id: string;
    source_id?: string;
  }[];
  const stopCode = new Map<string, string>();
  for (const s of stops) {
    if (s.source_id && !stopCode.has(s.station_id)) stopCode.set(s.station_id, s.source_id);
  }

  const keys = stations.map((s) => spec.keyOf(s, (id) => stopCode.get(id)));
  const keyToIndex = new Map(keys.map((k, i) => [k, i]));
  const n = stations.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const originIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isStationRoutable(stations[i].status)) originIdx.push(i);
  }

  console.log(
    `${spec.networkId}: fare origins ${originIdx.length}/${n} (concurrency ${concurrency})`
  );
  const t0 = Date.now();
  let done = 0;
  let failed = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const pos = next++;
      if (pos >= originIdx.length) return;
      const idx = originIdx[pos];
      const originKey = keys[idx];
      try {
        const prices = toMap(await spec.queryAll(originKey));
        for (const [destKey, price] of prices) {
          const j = keyToIndex.get(destKey);
          if (j == null || !Number.isFinite(price)) continue;
          matrix[idx][j] = price;
          matrix[j][idx] = price;
        }
      } catch (err) {
        failed++;
        console.warn(`  fare origin ${originKey} failed: ${err}`);
      }
      done++;
      if (done % 50 === 0) {
        console.log(`  ${spec.networkId}: origins ${done}/${originIdx.length}`);
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(originIdx.length, 1)) }, () => worker())
  );

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: spec.networkId,
    generated_at: new Date().toISOString(),
    source: [spec.source],
    currency: spec.currency,
    unit: spec.unit,
    station_ids: stations.map((s) => s.id),
    fares: matrix
  };
  await writeFile(join(ctx.dataDir, 'fares.json'), `${JSON.stringify(document)}\n`, 'utf-8');
  console.log(
    `${spec.networkId}: wrote fares.json (${n}x${n}, origin failures ${failed}, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s)`
  );
}
