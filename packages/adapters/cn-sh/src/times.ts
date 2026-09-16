/**
 * Harvest Shanghai Metro segment + transfer times from the official
 * path & fare planner (`plantrip`).
 *
 * - Adjacent-stop OD → `passStationList[].waitTime` (minutes) is the ride
 *   time to that station from the previous one; values sum to `time`.
 * - A real interchange appears in `transferStationList` with
 *   `transferStationTime` (minutes). Only paths that actually transfer
 *   carry a non-empty value.
 *
 * Adjacent + one targeted OD per missing transfer pair keeps the query
 * count at O(segments + missing-transfers), far below the full fare matrix.
 */
import {
  adjacentStopPairs,
  type HarvestedSegmentTime,
  type HarvestedTransferTime,
  mapPool,
  neighbourStop,
  type PatternEncoded,
  proxyUrl,
  type StopEncoded,
  type TransferEncoded
} from '@openmetro/core';

const SOURCE_ID = 'shmetro-plantrip';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlantripStop {
  stationId?: string;
  stationName?: string;
  waitTime?: string | number;
}

interface PlantripTransfer {
  line?: string;
  stationName?: string;
  stationId?: string;
  transferStationTime?: string | number;
  transferStationDirection?: string;
}

interface PlantripPath {
  time?: string | number;
  passStationList?: PlantripStop[];
  transferStationList?: PlantripTransfer[];
}

async function queryPlantrip(
  startId: string,
  endId: string,
  retries = 3
): Promise<PlantripPath | undefined> {
  const url = proxyUrl(
    `https://m.shmetro.com/interface/plantrip/pt.aspx?func=plantrip&startId=${encodeURIComponent(
      startId
    )}&endId=${encodeURIComponent(endId)}&planTime=00:59&week=1&ticket=oneWay&type=0`
  );
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://m.shmetro.com/'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000)
      });
      if (res.status >= 300 && res.status < 400) throw new Error(`redirect ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.startsWith('<')) throw new Error('html body');
      const j = JSON.parse(text) as { pathList?: PlantripPath[] };
      return j.pathList?.[0];
    } catch {
      await sleep(400 * 2 ** attempt);
    }
  }
  return undefined;
}

function minutesToSeconds(v: string | number | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : undefined;
}

export interface ShanghaiTimesInput {
  patterns: PatternEncoded[];
  stops: StopEncoded[];
  transfers: TransferEncoded[];
  /** stop_id → official per-line code used as plantrip startId/endId. */
  stopCode: (stopId: string) => string | undefined;
  /** station_id → Chinese display name, used to match transfer hits. */
  stationName?: (stationId: string) => string | undefined;
  concurrency?: number;
  delayMs?: number;
}

export async function collectShanghaiPlannerTimes(
  input: ShanghaiTimesInput
): Promise<{ segments: HarvestedSegmentTime[]; transfers: HarvestedTransferTime[] }> {
  const concurrency = input.concurrency ?? 8;
  const delayMs = input.delayMs ?? 80;
  const stopById = new Map(input.stops.map((s) => [s.id, s]));

  // ── 1. Adjacent-stop segment times ────────────────────────────
  const pairs = adjacentStopPairs(input.patterns).filter((p) => {
    const a = input.stopCode(p.from_stop_id);
    const b = input.stopCode(p.to_stop_id);
    return a && b && stopById.get(p.from_stop_id)?.line_id === stopById.get(p.to_stop_id)?.line_id;
  });
  console.log(`  plantrip adjacent ODs: ${pairs.length}`);
  let segDone = 0;
  const segResults = await mapPool(
    pairs,
    async (p) => {
      const a = input.stopCode(p.from_stop_id);
      const b = input.stopCode(p.to_stop_id);
      if (!a || !b) return undefined;
      const path = await queryPlantrip(a, b);
      segDone++;
      if (segDone % 100 === 0) console.log(`    adjacent ${segDone}/${pairs.length}`);
      const stops = path?.passStationList ?? [];
      if (stops.length < 2) return undefined;
      // Origin is stop[0]; waitTime on stop[1] is the ride time for this hop.
      const seconds = minutesToSeconds(stops[1].waitTime);
      if (seconds == null) return undefined;
      return {
        from_stop_id: p.from_stop_id,
        to_stop_id: p.to_stop_id,
        travel_time_seconds: seconds,
        source_id: SOURCE_ID
      } satisfies HarvestedSegmentTime;
    },
    { concurrency, delayMs }
  );
  const segments = segResults.filter((x): x is HarvestedSegmentTime => x != null);

  // ── 2. Missing transfer walk times ────────────────────────────
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
    hubName: string;
    startCode: string;
    endCode: string;
  };
  const jobs: XferJob[] = [];
  for (const t of missing) {
    if (!t.from_stop_id || !t.to_stop_id) continue;
    const fromStop = t.from_stop_id;
    const toStop = t.to_stop_id;
    const fromPatterns = patternsByLine.get(t.from_line_id) ?? input.patterns;
    const toPatterns = patternsByLine.get(t.to_line_id) ?? input.patterns;
    // Approach the hub on the from-line and leave it on the to-line.
    const approach = neighbourStop(fromPatterns, fromStop, -1);
    const depart = neighbourStop(toPatterns, toStop, 1);
    if (!approach || !depart) continue;
    const startCode = input.stopCode(approach);
    const endCode = input.stopCode(depart);
    if (!startCode || !endCode) continue;
    jobs.push({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id,
      hubName: input.stationName?.(t.station_id) ?? '',
      startCode,
      endCode
    });
  }
  console.log(`  plantrip transfer ODs: ${jobs.length}`);
  let xferDone = 0;
  const xferResults = await mapPool(
    jobs,
    async (job) => {
      const path = await queryPlantrip(job.startCode, job.endCode);
      xferDone++;
      if (xferDone % 50 === 0) console.log(`    transfer ${xferDone}/${jobs.length}`);
      const hits = (path?.transferStationList ?? []).filter(
        (t) => minutesToSeconds(t.transferStationTime) != null
      );
      // Prefer the hub we targeted; otherwise first timed entry.
      const hit =
        (job.hubName ? hits.find((h) => h.stationName === job.hubName) : undefined) ?? hits[0];
      const seconds = minutesToSeconds(hit?.transferStationTime);
      if (seconds == null) return undefined;
      return {
        station_id: job.station_id,
        from_line_id: job.from_line_id,
        to_line_id: job.to_line_id,
        walk_time_seconds: seconds,
        source_id: SOURCE_ID
      } satisfies HarvestedTransferTime;
    },
    { concurrency, delayMs }
  );
  const transfers = xferResults.filter((x): x is HarvestedTransferTime => x != null);

  console.log(
    `  plantrip harvest: ${segments.length} segment times, ${transfers.length} transfer times`
  );
  return { segments, transfers };
}
