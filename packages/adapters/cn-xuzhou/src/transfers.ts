/**
 * Transfer walk harvest for cn-xuzhou.
 *
 * The operator publishes no transfer walk data — the station pages list exits,
 * landmarks and in-station facilities but never a walking time between two
 * lines — so the station-hall walk at each interchange is measured from the
 * planner instead.
 *
 * A cross-line journey routes as
 * `walk → rail on line A → walk (站厅换乘) → rail on line B → walk`, so the
 * walk step that sits **between** the two rail legs is the transfer walk. The
 * access walk before the first leg and the egress walk after the last leg are
 * excluded.
 *
 * The six interchanges are 彭城广场 (L1/L2), 徐州火车站 (L1/L3),
 * 徐州东站 (L1/L6), 淮塔 (L2/L3), 市行政中心 (L2/L6) and 玉泉河 (L3/L6) —
 * all same-station, in-station transfers.
 *
 * Two planner caveats, both reproduced on 2026-10-23:
 *
 * - The planner models **most** interchanges with the same station-hall walk
 *   (193 s / 231 m at 彭城广场, 淮塔 and 市行政中心), so that value is the
 *   planner's modelled default rather than a per-station measurement. Only
 *   徐州火车站 differs (258 s / 309 m).
 * - The planner **does not know the 徐州东站 interchange**: line 1 and line 6
 *   both end there, and a cross-line query is answered with a single 2.2 km
 *   walking leg instead of a line-6 ride. The station-hall walk therefore
 *   cannot be measured there and the edge keeps the routing default.
 */
import { fetchBaiduRoute, foldStopName } from './baidu.js';
import type { XuzhouLineConfig } from './lines.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Offsets tried for the boarding side (before the interchange) and the exit
 * side.
 *
 * The origin is always a station **before** the interchange on the first line
 * (`fromStops[fromIdx - offset]`), so the traveller rides line A into the
 * interchange. The destination may lie **after** the interchange on the second
 * line (`toStops[toIdx + offset]`) or **before** it (`toStops[toIdx - offset]`)
 * — the second case is what a terminus-to-terminus interchange needs: at
 * 徐州东站 both line 1 and line 6 end, so line 6 must be ridden backwards
 * out of the interchange.
 */
const ORIGIN_OFFSETS = [3, 2, 1, 4, 5];
const DEST_OFFSETS = [1, 2, 3, 4, 5, -1, -2, -3];

export interface TransferStopRef {
  name: string;
  lon: number;
  lat: number;
}

export interface TransferCandidate {
  /** Canonical station id. */
  stationId: string;
  /** Station name as the operator publishes it. */
  stationName: string;
  lon: number;
  lat: number;
  /** The lines this station serves, in canonical line-id order. */
  lineIds: string[];
  /** Ordered stops of each served line. */
  stopsByLine: Map<string, TransferStopRef[]>;
  /** Line registry per line id. */
  cfgByLine: Map<string, XuzhouLineConfig>;
}

export interface HarvestedTransferWalk {
  stationId: string;
  fromLineId: string;
  toLineId: string;
  walkTimeSeconds?: number;
  walkDistanceMeters?: number;
  sourceId: string;
}

interface RouteStepLike {
  kind: 'rail' | 'walk';
  leg?: { lineName: string; onStation: string; offStation: string };
  walk?: { distanceMeters: number | null; durationSeconds: number | null };
}

/**
 * The walk step(s) between the rail leg on `firstLine` and the rail leg on
 * `secondLine`.
 *
 * The second leg must be the **first rail leg after** the first one, so a
 * route that chains three lines (A → C → B) cannot smear two station-hall
 * walks into one measurement. Returns the summed distance/duration of every
 * walk step between the two legs, or null when the route does not chain those
 * two lines directly.
 */
export function stationHallWalk(
  steps: RouteStepLike[],
  firstLineHint: string,
  secondLineHint: string
): {
  distanceMeters: number;
  durationSeconds: number;
  fromLeg: NonNullable<RouteStepLike['leg']>;
  toLeg: NonNullable<RouteStepLike['leg']>;
} | null {
  const railSteps = steps
    .map((s, i) => (s.kind === 'rail' && s.leg ? { i, leg: s.leg } : null))
    .filter((x): x is { i: number; leg: NonNullable<RouteStepLike['leg']> } => x != null);
  const first = railSteps.find((r) => r.leg.lineName.includes(firstLineHint));
  if (!first) return null;
  // The first rail leg after it must be the second line.
  const second = railSteps.find((r) => r.i > first.i && r.leg.lineName.includes(secondLineHint));
  if (!second) return null;
  if (second.i - first.i < 2) return null;

  let distanceMeters = 0;
  let durationSeconds = 0;
  let found = false;
  for (let i = first.i + 1; i < second.i; i++) {
    const step = steps[i]!;
    if (step.kind !== 'walk' || !step.walk) continue;
    found = true;
    distanceMeters += step.walk.distanceMeters ?? 0;
    durationSeconds += step.walk.durationSeconds ?? 0;
  }
  if (!found) return null;
  return {
    distanceMeters,
    durationSeconds,
    fromLeg: first.leg,
    toLeg: second.leg
  };
}

/**
 * Harvest the station-hall walk for every interchange of the network.
 *
 * Each interchange is measured once per ordered line pair; the walk is
 * symmetric in a station, so the reverse edge reuses the same measurement.
 */
export async function harvestTransferWalks(
  ak: string,
  candidates: TransferCandidate[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedTransferWalk[]> {
  const delayMs = opts.delayMs ?? 320;
  const retries = opts.retries ?? 1;
  const out: HarvestedTransferWalk[] = [];

  for (const candidate of candidates) {
    const lineIds = candidate.lineIds;
    for (const fromLineId of lineIds) {
      for (const toLineId of lineIds) {
        if (fromLineId === toLineId) continue;
        const fromCfg = candidate.cfgByLine.get(fromLineId);
        const toCfg = candidate.cfgByLine.get(toLineId);
        const fromStops = candidate.stopsByLine.get(fromLineId) ?? [];
        const toStops = candidate.stopsByLine.get(toLineId) ?? [];
        if (!fromCfg || !toCfg) continue;

        const fromIdx = fromStops.findIndex(
          (s) => foldStopName(s.name) === foldStopName(candidate.stationName)
        );
        const toIdx = toStops.findIndex(
          (s) => foldStopName(s.name) === foldStopName(candidate.stationName)
        );
        if (fromIdx < 0 || toIdx < 0) continue;

        let measured: { distanceMeters: number; durationSeconds: number } | null = null;
        for (const originOffset of ORIGIN_OFFSETS) {
          const oIdx = fromIdx - originOffset;
          if (oIdx < 0) continue;
          for (const destOffset of DEST_OFFSETS) {
            const dIdx = toIdx + destOffset;
            if (dIdx < 0 || dIdx >= toStops.length) continue;
            const origin = fromStops[oIdx]!;
            const dest = toStops[dIdx]!;

            for (let attempt = 0; attempt <= retries; attempt++) {
              const route = await fetchBaiduRoute(
                ak,
                { lon: origin.lon, lat: origin.lat },
                { lon: dest.lon, lat: dest.lat }
              ).catch(() => null);
              if (route) {
                const walk = stationHallWalk(
                  route.steps,
                  fromCfg.baiduNameHint,
                  toCfg.baiduNameHint
                );
                // The route must actually transfer at this station: the first
                // line must drop the traveller here and the second line must
                // pick them up here.
                const transfersHere =
                  walk != null &&
                  foldStopName(walk.fromLeg.offStation) === foldStopName(candidate.stationName) &&
                  foldStopName(walk.toLeg.onStation) === foldStopName(candidate.stationName);
                if (walk && transfersHere) {
                  measured = walk;
                  break;
                }
              }
              await sleep(opts.delayMs ?? 320);
            }
            if (measured) break;
          }
          if (measured) break;
        }

        if (!measured || measured.durationSeconds <= 0) {
          console.log(
            `  transfer walk miss: ${candidate.stationName} ${fromLineId} -> ${toLineId}`
          );
          continue;
        }
        out.push({
          stationId: candidate.stationId,
          fromLineId,
          toLineId,
          walkTimeSeconds: Math.round(measured.durationSeconds),
          walkDistanceMeters: Math.round(measured.distanceMeters),
          sourceId: 'baidu-transit-station-hall-walk'
        });
        console.log(
          `  transfer walk ${candidate.stationName} ${fromLineId} -> ${toLineId}: ` +
            `${measured.durationSeconds}s / ${measured.distanceMeters}m`
        );
        await sleep(delayMs);
      }
    }
  }
  return out;
}
