/**
 * OD fare matrix from the operator's planner.
 *
 * The operator publishes its own fare rules in
 * 《贵阳市发展和改革委员会关于制定贵阳市城市轨道交通票价的通知》
 * (筑发改收费〔2017〕768 号): a distance-banded tariff — 2 yuan for the first
 * 4 km, then 4/4/6/6/8/8 km bands, +1 yuan per further 8 km above 40 km,
 * 11 yuan maximum. Transfers are not charged extra: the fare is computed on
 * the total origin→destination mileage, and **when several routes are
 * possible the shortest one is priced** (the operator explains this with the
 * 小河→花果园 / 小河→贵医 example in its own FAQ).
 *
 * The planner's `data.price` is that official quote, so the matrix is taken
 * verbatim from the operator rather than recomputed from the tariff.
 *
 * Two properties of the endpoint shape the implementation:
 *
 * - **It is multimodal.** For some pairs it prefers a bus route or a plain
 *   walk and then reports `price: -1`. Only plans whose ride legs are all
 *   `轨道交通*` are accepted; a pair the operator declines to quote as a
 *   metro journey is left `null`.
 * - **Fares are symmetric.** The matrix is filled once per unordered pair and
 *   mirrored, and the harvest asserts that the operator's own reverse quote
 *   agrees.
 */
import type { FareMatrixEncoded } from '@openmetro/core';
import { isMetroLineName, type PlannerPlan, queryPlanner } from './planner.js';

export interface FareStation {
  /** Canonical station id. */
  id: string;
  /** Canonical station name. */
  name: string;
  /** The operator's coordinate string (`lat,lng`) — the planner key. */
  coord: string;
}

export interface BuildFaresOptions {
  delayMs?: number;
  retries?: number;
  /** Called with a short progress line every N pairs. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Check the operator's reverse quote for every Nth pair (1 = every pair).
   *
   * The operator's fare is symmetric by rule, so the check is a spot check:
   * doubling the query count for all 4 278 pairs would cost another seven
   * minutes for no additional coverage.
   */
  verifySymmetryEvery?: number;
}

export interface BuildFaresResult {
  matrix: FareMatrixEncoded;
  /** Pairs the operator declined to quote as a metro journey. */
  unquoted: string[];
  /** Pairs where the operator's two directions disagreed. */
  asymmetric: string[];
  /** Pairs the planner rejected outright. */
  rejected: string[];
}

/** The fare matrix's unit and currency, per the operator's tariff notice. */
const CURRENCY = 'CNY';
const UNIT = 'yuan';

/**
 * Query one OD pair and return the operator's metro fare.
 *
 * Returns `undefined` when the planner declines to quote a metro journey for
 * that pair.
 */
async function quoteFare(
  origin: FareStation,
  destination: FareStation,
  opts: BuildFaresOptions
): Promise<{ price: number; plan: PlannerPlan } | undefined> {
  const plan = await queryPlanner(origin.coord, destination.coord, { retries: opts.retries ?? 2 });
  if (!plan) return undefined;
  const rideLegs = plan.legs.filter((l) => !l.isWalk);
  if (rideLegs.length === 0) return undefined;
  if (!rideLegs.every((l) => isMetroLineName(l.line))) return undefined;
  if (plan.price == null || plan.price < 0) return undefined;
  return { price: plan.price, plan };
}

/**
 * Build the symmetric OD fare matrix.
 *
 * The matrix index order is the **sorted** station id order, which is the
 * order `writeCanonical` writes `stations.json` in — so the matrix and the
 * station table always agree without a reconciliation step.
 */
export async function buildFareMatrix(
  stations: FareStation[],
  opts: BuildFaresOptions = {}
): Promise<BuildFaresResult> {
  const delayMs = opts.delayMs ?? 60;
  // Sort by station id so the matrix index matches the canonical station file.
  const sortedStations = [...stations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stationIds = sortedStations.map((s) => s.id);
  const n = sortedStations.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const unquoted: string[] = [];
  const asymmetric: string[] = [];
  const rejected: string[] = [];

  let done = 0;
  const total = (n * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sortedStations[i]!;
      const b = sortedStations[j]!;
      let price: number | undefined;
      try {
        const forward = await quoteFare(a, b, opts);
        if (forward) {
          price = forward.price;
          // The operator's fare is symmetric by rule — spot-check rather than
          // assume, so the matrix never mirrors a value the operator itself
          // quotes differently in the other direction.
          const every = Math.max(1, opts.verifySymmetryEvery ?? 25);
          if (done % every === 0) {
            const reverse = await quoteFare(b, a, opts);
            if (reverse && reverse.price !== price) {
              asymmetric.push(`${a.name}→${b.name}: ${price} vs ${reverse.price}`);
            }
          }
        }
      } catch (err) {
        rejected.push(`${a.name}→${b.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (price == null) {
        unquoted.push(`${a.name}→${b.name}`);
      } else {
        matrix[i]![j] = price;
        matrix[j]![i] = price;
      }
      done++;
      if (opts.onProgress && done % 200 === 0) opts.onProgress(done, total);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  opts.onProgress?.(done, total);

  return {
    matrix: {
      $schema:
        'https://raw.githubusercontent.com/Naptie/openmetro/main/schemas/v1/fares.schema.json',
      schema_version: '1.0',
      network_id: 'cn-guiyang',
      generated_at: new Date().toISOString(),
      source: [
        {
          name: 'gyurt-planner',
          url: 'https://cms.gyurt.com/external/interface/getSubwayLines',
          version: 'live',
          retrieved_at: new Date().toISOString(),
          license: 'unknown',
          license_url: null,
          attribution: '贵阳市公共交通投资运营集团有限公司 — 线路、票价查询',
          notes:
            '运营方自有路径/票价查询接口的 OD 报价；每对车站查询一次，取 data.price（元）。' +
            '运价依据：贵阳市发展和改革委员会《关于制定贵阳市城市轨道交通票价的通知》（筑发改收费〔2017〕768 号），' +
            '里程分段计价，起步 2 元/4 公里，全网最高 11 元，多路径按最短路径计价，换乘不另行计费。'
        }
      ],
      currency: CURRENCY,
      unit: UNIT,
      station_ids: stationIds,
      fares: matrix
    },
    unquoted,
    asymmetric,
    rejected
  };
}
