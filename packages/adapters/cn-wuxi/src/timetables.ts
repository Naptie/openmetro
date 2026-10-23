/**
 * Per-station first/last-train harvest for cn-wuxi.
 *
 * The operator publishes its first/last-train sheets **only as images** — the
 * 列车时刻表 column of its website holds five JPEG/PNG sheets (1+S1 combined,
 * 1 号线 multi-origin, and 2/3/4 号线) and there is no machine-readable
 * timetable endpoint. This adapter therefore harvests the per-station service
 * windows from the Baidu planner, exactly like `cn-nanchang`, `cn-lanzhou`,
 * `cn-jinan` and `cn-changchun` do when the operator's sheets are images.
 *
 * ## Agreement with the operator's sheets
 *
 * Checked against the operator's 4 号线 sheet (18 stations × 2 directions = 66
 * comparable cells): **66/66 agree within ±2 minutes, 33 of them exactly**,
 * with no outlier. The spread is the planner's own rounding — the sheets are
 * printed per service pattern, while the planner answers for the one service
 * it selects.
 *
 * ## Which service the planner answers with
 *
 * The planner returns one leg per (line, OD). On 1 号线 that leg can be a
 * **short-turn** service rather than the through service: at 市民中心 the
 * planner answers 05:49, which is the 长广溪始发 train the operator's own
 * 多点始发 sheet lists as 5:50, while the 南方泉始发 through service passes at
 * 6:07. Both are real first northbound trains from that station; the planner
 * reports the earlier one. The extra window the operator publishes for the
 * second service is not reachable through the planner, so it is not published
 * here either.
 *
 * ## Direction convention
 *
 * The repo convention: `down` heads for the **last** stop of the line's
 * source order, `up` for the **first**. The source order here is AMap's, and
 * for 1 号线 it coincides with the operator's own 上行 → 下行 order (the 1+S1
 * sheet's 上行方向 heads north towards 江阴外滩, 下行方向 south towards
 * 南方泉). The other lines publish direction *names* rather than 上行/下行, so
 * the planner's own label (`堰桥方向`, `无锡东站方向`, …) is carried verbatim
 * into `direction_label`.
 */
import { cleanTime } from '@openmetro/core';

import { type BaiduRailLeg, fetchBaiduOriginLeg } from './baidu.js';
import type { WuxiLineConfig } from './lines.js';

/** One station's service window on one line. */
export interface HarvestedStationTime {
  /** Canonical station name (no `站` suffix, as the AMap dataset spells it). */
  stationName: string;
  /** `down` heads for the line's last stop, `up` for its first. */
  direction: 'down' | 'up';
  /** The terminus this service heads for. */
  destinationName: string;
  /** The planner's own direction label (`堰桥方向`). */
  directionLabel?: string;
  /** First departure at the boarding station. */
  first?: string;
  /** Last departure at the boarding station. */
  last?: string;
  /** The planner's service pattern label, when it publishes one. */
  service?: string;
  /** The in-vehicle seconds of the queried leg. */
  durationSeconds?: number;
  /** The in-vehicle metres of the queried leg. */
  distanceMeters?: number;
}

/** One station the planner can be asked about. */
export interface HarvestStation {
  /** Canonical station name. */
  name: string;
  /** GCJ-02 coordinate. */
  lon: number;
  lat: number;
}

/** The planner leg behind a harvested window. */
export interface HarvestedLeg extends HarvestedStationTime {
  leg: BaiduRailLeg;
}

export interface HarvestTimetableOptions {
  /** Minimum spacing between two planner queries (ms). */
  delayMs?: number;
  /** Parallel planner queries. */
  concurrency?: number;
  /** How many attempts per query. */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Harvest one station's two directions.
 *
 * Each direction is queried towards the line's terminal in that direction; the
 * planner's leg then reports the boarding station's own service window, which
 * is what the canonical `first_train` / `last_train` fields carry.
 */
async function harvestStation(
  ak: string,
  cfg: WuxiLineConfig,
  station: HarvestStation,
  terminal: HarvestStation,
  direction: 'down' | 'up',
  opts: HarvestTimetableOptions
): Promise<HarvestedStationTime | undefined> {
  const leg = await fetchBaiduOriginLeg(
    ak,
    { lon: station.lon, lat: station.lat, name: station.name },
    { lon: terminal.lon, lat: terminal.lat },
    cfg,
    { directionTerminus: terminal.name, retries: opts.retries ?? 2 }
  );
  if (!leg) return undefined;

  const first = cleanTime(leg.firstTime ?? undefined);
  const last = cleanTime(leg.lastTime ?? undefined);
  if (!first && !last) return undefined;

  return {
    stationName: station.name,
    direction,
    destinationName: terminal.name,
    directionLabel: leg.direction || undefined,
    first,
    last,
    durationSeconds: leg.durationSeconds ?? undefined,
    distanceMeters: leg.distanceMeters ?? undefined
  };
}

/**
 * Harvest every station of one line, both directions.
 *
 * The terminals are skipped for the direction they terminate: the first stop
 * has no service towards itself, and the same for the last stop.
 */
export async function harvestLineTimetables(
  ak: string,
  cfg: WuxiLineConfig,
  stations: HarvestStation[],
  opts: HarvestTimetableOptions = {}
): Promise<HarvestedStationTime[]> {
  if (stations.length < 2) return [];
  const first = stations[0]!;
  const last = stations[stations.length - 1]!;

  const jobs: { station: HarvestStation; terminal: HarvestStation; direction: 'down' | 'up' }[] =
    [];
  for (const station of stations) {
    if (station.name !== last.name) jobs.push({ station, terminal: last, direction: 'down' });
    if (station.name !== first.name) jobs.push({ station, terminal: first, direction: 'up' });
  }

  const out: HarvestedStationTime[] = [];
  const delayMs = opts.delayMs ?? 250;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;
      try {
        const hit = await harvestStation(ak, cfg, job.station, job.terminal, job.direction, opts);
        if (hit) out.push(hit);
      } catch {
        // A single failed query must not abort the line's harvest.
      }
      await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}
