/**
 * Harvest Beijing Subway segment + transfer times from the official map
 * route planner (`searchstartend`).
 *
 * `fangan[0].p` is an **array of ride legs**. Each row is
 * `[lineCode, stationName, t_cum, stationIndex, …]` where `t_cum` is
 * cumulative seconds from the origin (ride only on the first row of a leg;
 * the gap between last row of leg i and first row of leg i+1 is the
 * transfer walk). Consecutive diffs inside a leg give ride times.
 *
 * Used only to fill gaps: official `beijing.xml` `@_ut` and
 * `interchange.xml` remain authoritative when present.
 */
import {
  adjacentStopPairs,
  type HarvestedSegmentTime,
  type HarvestedTransferTime,
  mapPool,
  neighbourStop,
  officialFetchHeaders,
  type PatternEncoded,
  proxyUrl,
  type StopEncoded,
  type TransferEncoded
} from '@openmetro/core';

const SOURCE_ID = 'bjsubway-searchstartend';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `[lineCode, stationName, t_cum, stationIndex, …]` */
type BjPathRow = (string | number)[];

interface BjRouteResponse {
  result?: string;
  fangan?: { p?: BjPathRow[][]; t?: string; m?: number }[];
  price?: number;
}

/**
 * Query the official route planner. Network/proxy/HTML/JSON failures throw
 * after retries so a flaky sync cannot silently drop harvested times.
 * A successful JSON body with no route still returns the parsed response.
 */
async function querySearchStartEnd(
  start: string,
  end: string,
  retries = 3
): Promise<BjRouteResponse | undefined> {
  const url = proxyUrl(
    `https://map.bjsubway.com/searchstartend?start=${encodeURIComponent(
      start
    )}&end=${encodeURIComponent(end)}&mintype=1&time=12:00`
  );
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({ Referer: 'https://map.bjsubway.com/' }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.startsWith('<')) throw new Error('html body');
      return JSON.parse(text) as BjRouteResponse;
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw new Error(
    `searchstartend ${start}->${end}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

function allLegs(j: BjRouteResponse | undefined): BjPathRow[][] {
  const legs = j?.fangan?.[0]?.p ?? [];
  return legs.filter((leg) => leg.length >= 1);
}

function firstLeg(j: BjRouteResponse | undefined): BjPathRow[] | undefined {
  const legs = allLegs(j);
  return legs.find((leg) => leg.length >= 2);
}

function cumSeconds(row: BjPathRow): number | undefined {
  const n = Number(row[2]);
  return Number.isFinite(n) ? n : undefined;
}

function stationName(row: BjPathRow): string {
  return String(row[1] ?? '');
}

export interface BeijingTimesInput {
  patterns: PatternEncoded[];
  stops: StopEncoded[];
  transfers: TransferEncoded[];
  /** Chinese display name for the planner. */
  stopName: (stopId: string) => string | undefined;
  concurrency?: number;
  delayMs?: number;
}

export async function collectBeijingPlannerTimes(
  input: BeijingTimesInput
): Promise<{ segments: HarvestedSegmentTime[]; transfers: HarvestedTransferTime[] }> {
  const concurrency = input.concurrency ?? 8;
  const delayMs = input.delayMs ?? 80;

  // ── 1. Adjacent-stop segment times (overwrite last_train/estimated only;
  //        applyHarvestedSegmentTimes already protects `source`) ──
  const pairs = adjacentStopPairs(input.patterns).filter((p) => {
    const a = input.stopName(p.from_stop_id);
    const b = input.stopName(p.to_stop_id);
    return Boolean(a && b && a !== b);
  });
  console.log(`  searchstartend adjacent ODs: ${pairs.length}`);
  let segDone = 0;
  const failures: string[] = [];
  const segResults = await mapPool(
    pairs,
    async (p) => {
      const a = input.stopName(p.from_stop_id);
      const b = input.stopName(p.to_stop_id);
      if (!a || !b) return undefined;
      try {
        const path = firstLeg(await querySearchStartEnd(a, b));
        if (!path || path.length < 2) return undefined;
        // Single-hop responses are the common case for adjacent pairs.
        if (path.length === 2) {
          const t0 = cumSeconds(path[0]);
          const t1 = cumSeconds(path[1]);
          if (t0 != null && t1 != null && t1 > t0) {
            return {
              from_stop_id: p.from_stop_id,
              to_stop_id: p.to_stop_id,
              travel_time_seconds: t1 - t0,
              source_id: SOURCE_ID
            } satisfies HarvestedSegmentTime;
          }
        }
        // Multi-stop first leg: find the hop matching the requested pair.
        for (let i = 0; i < path.length - 1; i++) {
          const n0 = stationName(path[i]);
          const n1 = stationName(path[i + 1]);
          if (!((n0 === a && n1 === b) || (n0 === b && n1 === a))) continue;
          const t0 = cumSeconds(path[i]);
          const t1 = cumSeconds(path[i + 1]);
          if (t0 == null || t1 == null) continue;
          const dt = t1 - t0;
          if (!(dt > 0)) continue;
          return {
            from_stop_id: p.from_stop_id,
            to_stop_id: p.to_stop_id,
            travel_time_seconds: dt,
            source_id: SOURCE_ID
          } satisfies HarvestedSegmentTime;
        }
        return undefined;
      } catch (err) {
        failures.push(
          `segment ${p.from_stop_id}->${p.to_stop_id}: ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      } finally {
        segDone++;
        if (segDone % 100 === 0) console.log(`    adjacent ${segDone}/${pairs.length}`);
      }
    },
    { concurrency, delayMs }
  );
  const segments = segResults.filter((x): x is HarvestedSegmentTime => x != null);

  // ── 2. Missing transfer walk times via t_cum jump at the hub ──
  const missing = input.transfers.filter((t) => t.walk_time_seconds == null);
  const patternsByLine = new Map<string, PatternEncoded[]>();
  for (const p of input.patterns) {
    const arr = patternsByLine.get(p.line_id) ?? [];
    arr.push(p);
    patternsByLine.set(p.line_id, arr);
  }

  type XferJob = {
    station_id: string;
    from_line_id: string;
    to_line_id: string;
    startName: string;
    endName: string;
    hubName: string;
  };
  const jobs: XferJob[] = [];
  for (const t of missing) {
    if (!t.from_stop_id || !t.to_stop_id) continue;
    const hubName = input.stopName(t.from_stop_id);
    if (!hubName) continue;
    const fromPatterns = patternsByLine.get(t.from_line_id) ?? input.patterns;
    const toPatterns = patternsByLine.get(t.to_line_id) ?? input.patterns;
    const approach = neighbourStop(fromPatterns, t.from_stop_id, -1);
    const depart = neighbourStop(toPatterns, t.to_stop_id, 1);
    if (!approach || !depart) continue;
    const startName = input.stopName(approach);
    const endName = input.stopName(depart);
    if (!startName || !endName || startName === endName) continue;
    jobs.push({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id,
      startName,
      endName,
      hubName
    });
  }
  console.log(`  searchstartend transfer ODs: ${jobs.length}`);
  let xferDone = 0;
  const xferResults = await mapPool(
    jobs,
    async (job) => {
      try {
        const legs = allLegs(await querySearchStartEnd(job.startName, job.endName));
        if (legs.length < 2) return undefined;
        // Transfer walk = t_cum(first row of leg i+1) − t_cum(last row of leg i)
        // when both endpoints are the hub.
        for (let i = 0; i < legs.length - 1; i++) {
          const a = legs[i][legs[i].length - 1];
          const b = legs[i + 1][0];
          if (!a || !b) continue;
          if (stationName(a) !== job.hubName || stationName(b) !== job.hubName) continue;
          const t0 = cumSeconds(a);
          const t1 = cumSeconds(b);
          if (t0 == null || t1 == null) continue;
          const dt = t1 - t0;
          // Sanity: metro transfer walks are tens of seconds to ~10 minutes.
          if (!(dt >= 30 && dt <= 600)) continue;
          return {
            station_id: job.station_id,
            from_line_id: job.from_line_id,
            to_line_id: job.to_line_id,
            walk_time_seconds: dt,
            source_id: SOURCE_ID
          } satisfies HarvestedTransferTime;
        }
        return undefined;
      } catch (err) {
        failures.push(
          `transfer ${job.station_id} ${job.from_line_id}->${job.to_line_id}: ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      } finally {
        xferDone++;
        if (xferDone % 50 === 0) console.log(`    transfer ${xferDone}/${jobs.length}`);
      }
    },
    { concurrency, delayMs }
  );
  const transfers = xferResults.filter((x): x is HarvestedTransferTime => x != null);

  if (failures.length > 0) {
    throw new Error(
      `Beijing searchstartend fetch failed (${failures.length}):\n  - ${failures.slice(0, 40).join('\n  - ')}${failures.length > 40 ? `\n  … and ${failures.length - 40} more` : ''}`
    );
  }

  console.log(
    `  searchstartend harvest: ${segments.length} segment times, ${transfers.length} transfer times`
  );
  return { segments, transfers };
}
