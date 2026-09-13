import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncCtx } from '../adapter/contract.js';
import type { StationEncoded } from '../schema/index.js';

/**
 * Shared origin-destination fare-matrix orchestration.
 *
 * Fares are distance-based, so operators can only quote them per OD pair via
 * their official route/fare planners. Each adapter supplies a `FareSpec` (a
 * per-pair query plus the planner-side station key); this module enumerates
 * the upper triangle (fares are symmetric), runs the bounded worker pool with
 * retries, and writes `fares.json` into the sync context's data directory.
 */

export interface FareQueryOutcome {
  price: number | null;
  /** True when the failure is transient (server throttled / 5xx) and worth retrying. */
  retry: boolean;
}

export type FareQuery = (a: string, b: string) => Promise<FareQueryOutcome>;

export interface FareSpec {
  networkId: string;
  currency: string;
  unit: string;
  source: Record<string, unknown>;
  /**
   * Planner-side key for a station: the display name for name-keyed planners
   * (Beijing, Guangzhou) or the official per-line stop code for id-keyed ones
   * (Shanghai).
   */
  keyOf: (station: StationEncoded, stopCode: (stationId: string) => string | undefined) => string;
  query: FareQuery;
}

export interface FareSyncOptions {
  /** Parallel OD-pair queries (default 20). */
  concurrency?: number;
  /** Milliseconds to sleep between a worker's queries (default 0). */
  delay?: number;
}

const RETRY_BACKOFF_MS = [200, 500, 1200];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function queryWithRetry(query: FareQuery, a: string, b: string): Promise<FareQueryOutcome> {
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const outcome = await query(a, b);
      if (!outcome.retry) return outcome;
    } catch {
      // network/parse error: treat as transient
    }
    await sleep(RETRY_BACKOFF_MS[attempt] ?? 1000);
  }
  return { price: null, retry: true };
}

/**
 * Fetch every published OD fare for the network and write
 * `<ctx.dataDir>/fares.json`. A pair with no published fare is stored as
 * `null`; pairs that kept failing transiently after retries stay `null` too,
 * so the next sync (or `reconcileFares`) can fill them in without losing
 * known values.
 */
export async function syncFares(
  ctx: SyncCtx,
  spec: FareSpec,
  opts: FareSyncOptions = {}
): Promise<void> {
  const concurrency = opts.concurrency ?? 20;
  const delay = opts.delay ?? 0;

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
  const n = stations.length;

  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  console.log(
    `${spec.networkId}: ${n} stations, ${pairs.length} pairs (concurrency ${concurrency})`
  );

  let done = 0;
  let permanent = 0;
  let transient = 0;
  let next = 0;
  const t0 = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= pairs.length) return;
      const [i, j] = pairs[idx];
      const outcome = await queryWithRetry(spec.query, keys[i], keys[j]);
      if (outcome.price != null) {
        matrix[i][j] = outcome.price;
        matrix[j][i] = outcome.price;
      } else if (outcome.retry) {
        transient++;
      } else {
        permanent++;
      }
      done++;
      if (delay > 0) await sleep(delay);
      if (done % 2000 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(
          `  ${spec.networkId}: ${done}/${pairs.length} (no-fare ${permanent}, ` +
            `transient ${transient}, ${rate.toFixed(1)}/s)`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, () => worker()));

  const document = {
    $schema: `https://raw.githubusercontent.com/openmetro/schemas/v1/${spec.networkId}.fares.schema.json`,
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
    `${spec.networkId}: wrote fares.json (${n}x${n}, no-fare ${permanent}, ` +
      `transient ${transient}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`
  );
}
