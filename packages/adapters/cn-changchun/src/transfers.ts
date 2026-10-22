/**
 * Station-hall transfer walk harvest for cn-changchun.
 *
 * The official feed publishes the interchange **topology** — each stop carries
 * `transferinfo`, the official stop code of the same physical station on the
 * other line — but no transfer walk times at all. The station-hall walk at
 * each interchange is therefore measured from the planner.
 *
 * A cross-line journey routes as
 * `walk → rail on line A → walk (站厅换乘 / 站内通道换乘) → rail on line B → walk`,
 * so the walk step that sits **between** the two rail legs is the transfer
 * walk. The access walk before the first leg and the egress walk after the
 * last leg are excluded.
 *
 * The walk inside a station hall is symmetric, so each unordered line pair is
 * measured once and mirrored onto both directed edges.
 *
 * Caveat: the planner models most Changchun interchanges with the **same**
 * station-hall walk — "站厅换乘 步行231米" / 193 s appears at 人民广场,
 * 华庆路, 文化广场 and others — so the value is the planner's modelled
 * default rather than a per-station measurement. A few stations do get their
 * own figure ("站内通道换乘 步行351米" / 293 s at 职业技术大学,
 * "同台换乘 步行146米" / 122 s at 伪满皇宫).
 */
import { fetchBaiduRoute, foldStopName } from './baidu.js';
import type { ChangchunLineConfig } from './lines.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Offsets tried for the boarding side (around the interchange) and the exit
 * side.
 *
 * Both directions are tried on both sides: seven of Changchun's interchanges
 * sit at or next to a line terminus (北环城路 is the first station of both
 * 1号线 and 8号线, 东大桥 is the last station of 5号线, 长影世纪城 the last of
 * 3号线), and a one-sided offset leaves one of the two ends without a single
 * candidate origin or destination.
 */
const ORIGIN_OFFSETS = [3, -3, 2, -2, 1, -1, 4, -4, 5, -5];
const DEST_OFFSETS = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5];

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
  cfgByLine: Map<string, ChangchunLineConfig>;
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
  walk?: {
    distanceMeters: number | null;
    durationSeconds: number | null;
    startLocation?: { lon: number; lat: number };
    endLocation?: { lon: number; lat: number };
  };
}

/**
 * The walk step **nearest the hub**, among the walks that sit between two rail
 * legs.
 *
 * This is the lenient counterpart of {@link stationHallWalk}: it does not
 * require the two rail legs to be the two lines of the interchange, it only
 * requires the walk to happen at the hub. The planner sometimes books a
 * transfer through a *third* line (东大桥 4号线/5号线 comes back as
 * 4号线 → 3号线 → 5号线 with the concourse walk at 电台街), and the strict rule
 * then finds nothing at all.
 *
 * The walk's own endpoints are scored against the hub, so the walk that
 * actually happens at the interchange wins over one at a neighbouring station.
 */
export function nearestWalkToHub(
  steps: RouteStepLike[],
  hub: { lon: number; lat: number }
): { distanceMeters: number; durationSeconds: number; score: number } | null {
  const hits: { distanceMeters: number; durationSeconds: number; score: number }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step?.kind !== 'walk' || !step.walk) continue;
    const prev = steps[i - 1];
    const next = steps[i + 1];
    // A transfer walk sits between two rail legs.
    if (prev?.kind !== 'rail' || next?.kind !== 'rail') continue;
    const pts = [step.walk.startLocation, step.walk.endLocation].filter(
      (p): p is { lon: number; lat: number } => p != null
    );
    let score = Number.POSITIVE_INFINITY;
    for (const p of pts) {
      const dLon = (p.lon - hub.lon) * Math.cos((hub.lat * Math.PI) / 180);
      const dLat = p.lat - hub.lat;
      score = Math.min(score, Math.sqrt(dLon * dLon + dLat * dLat));
    }
    if (!Number.isFinite(score)) continue;
    hits.push({
      distanceMeters: step.walk.distanceMeters ?? 0,
      durationSeconds: step.walk.durationSeconds ?? 0,
      score
    });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.score - b.score);
  return hits[0]!;
}

/** How far (in degrees) a walk endpoint may sit from the hub and still count. */
const HUB_TOLERANCE_DEG = 0.004;

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
 * Each unordered line pair is measured once; the measurement is mirrored onto
 * both directed edges because the walk inside a station is symmetric.
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
    for (let a = 0; a < lineIds.length; a++) {
      for (let b = a + 1; b < lineIds.length; b++) {
        const fromLineId = lineIds[a]!;
        const toLineId = lineIds[b]!;
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
              const route = await fetchBaiduRoute(ak, origin, dest).catch(() => null);
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
                // Lenient fallback: the planner may book the interchange
                // through a third line, so accept the walk that happens nearest
                // the hub instead of requiring the two legs to be the two lines
                // of this interchange.
                const near = nearestWalkToHub(route.steps, {
                  lon: candidate.lon,
                  lat: candidate.lat
                });
                if (near && near.score <= HUB_TOLERANCE_DEG && near.durationSeconds > 0) {
                  measured = near;
                  break;
                }
              }
              await sleep(delayMs);
            }
            if (measured) break;
          }
          if (measured) break;
        }

        if (!measured || measured.durationSeconds <= 0) {
          console.log(
            `  transfer walk miss: ${candidate.stationName} ${fromLineId} <-> ${toLineId}`
          );
          continue;
        }
        for (const [from, to] of [
          [fromLineId, toLineId],
          [toLineId, fromLineId]
        ] as const) {
          out.push({
            stationId: candidate.stationId,
            fromLineId: from,
            toLineId: to,
            walkTimeSeconds: Math.round(measured.durationSeconds),
            walkDistanceMeters: Math.round(measured.distanceMeters),
            sourceId: 'baidu-transit-station-hall-walk'
          });
        }
        console.log(
          `  transfer walk ${candidate.stationName} ${fromLineId} <-> ${toLineId}: ` +
            `${measured.durationSeconds}s / ${measured.distanceMeters}m`
        );
        await sleep(delayMs);
      }
    }
  }
  return out;
}
