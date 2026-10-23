/**
 * Transfer walk harvest for cn-changsha.
 *
 * The operator publishes the identity of every interchange (the official
 * `huancheng` flag, 19 stations) but **no** transfer walk times, so the
 * station-hall walk at each interchange is measured from the planner.
 *
 * A cross-line journey routes as
 * `walk → rail on line A → walk (站厅换乘) → rail on line B → walk`, so the
 * walk step that sits **between** the two rail legs is the transfer walk. The
 * access walk before the first leg and the egress walk after the last leg are
 * excluded.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterCacheDir } from '@openmetro/core';
import { fetchBaiduRoute, foldStopName } from './baidu.js';
import type { ChangshaLineConfig } from './lines.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Offsets tried for the boarding side (before the interchange) and the exit
 * side.
 *
 * Negative offsets are included because two of the network's interchanges
 * sit at a line's terminus — 光达 is the last stop of both 2号线 and 4号线,
 * and 长沙火车南站 is the last stop of 4号线 — where the traveller has to
 * ride the second line *away* from the interchange. Without the negative
 * side no origin/destination pair exists and the walk stays unmeasured.
 */
const ORIGIN_OFFSETS = [3, 2, 1, 4, 5, -1, -2, -3, -4, -5];
const DEST_OFFSETS = [1, 2, 3, 4, 5, -1, -2, -3, -4, -5];

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
  cfgByLine: Map<string, ChangshaLineConfig>;
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
 * Cached station-hall walks, keyed by `stationId|fromLineId|toLineId`.
 *
 * The cache lives under the git-ignored `tmp/cache/` scratch dir and only
 * exists to spare repeat planner queries.
 */
interface WalkCache {
  harvestedAt: string;
  walks: Record<string, { walkTimeSeconds: number; walkDistanceMeters: number }>;
}

async function loadCache(): Promise<WalkCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(adapterCacheDir('cn-changsha'), 'transfer-walks.json'), 'utf-8')
    ) as WalkCache;
    if (raw && typeof raw.walks === 'object') return raw;
  } catch {
    // first run
  }
  return { harvestedAt: new Date().toISOString(), walks: {} };
}

/**
 * Harvest the station-hall walk for every interchange of the network.
 *
 * Each interchange is measured once per ordered line pair; the walk is
 * symmetric in a station, so the reverse edge reuses the same measurement.
 * Measurements from a previous run are reused.
 */
export async function harvestTransferWalks(
  ak: string,
  candidates: TransferCandidate[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedTransferWalk[]> {
  const delayMs = opts.delayMs ?? 320;
  const retries = opts.retries ?? 1;
  const cache = await loadCache();
  const out: HarvestedTransferWalk[] = [];
  let cached = 0;

  for (const candidate of candidates) {
    const lineIds = candidate.lineIds;
    for (const fromLineId of lineIds) {
      for (const toLineId of lineIds) {
        if (fromLineId === toLineId) continue;
        const cacheKey = `${candidate.stationId}|${fromLineId}|${toLineId}`;
        const hit = cache.walks[cacheKey];
        if (hit) {
          cached++;
          out.push({
            stationId: candidate.stationId,
            fromLineId,
            toLineId,
            walkTimeSeconds: hit.walkTimeSeconds,
            walkDistanceMeters: hit.walkDistanceMeters,
            sourceId: 'baidu-transit-station-hall-walk'
          });
          continue;
        }
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
          if (oIdx < 0 || oIdx >= fromStops.length) continue;
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
              await sleep(delayMs);
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
        cache.walks[cacheKey] = {
          walkTimeSeconds: Math.round(measured.durationSeconds),
          walkDistanceMeters: Math.round(measured.distanceMeters)
        };
        console.log(
          `  transfer walk ${candidate.stationName} ${fromLineId} -> ${toLineId}: ` +
            `${measured.durationSeconds}s / ${measured.distanceMeters}m`
        );
        await sleep(delayMs);
      }
    }
  }

  cache.harvestedAt = new Date().toISOString();
  await mkdir(adapterCacheDir('cn-changsha'), { recursive: true });
  await writeFile(
    join(adapterCacheDir('cn-changsha'), 'transfer-walks.json'),
    `${JSON.stringify(cache, null, 2)}\n`,
    'utf-8'
  );
  console.log(`  transfer walks: ${cached} cached, ${out.length - cached} harvested`);
  return out;
}
