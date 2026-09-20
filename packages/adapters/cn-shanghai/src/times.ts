/**
 * Harvest Shanghai Metro segment + transfer times from the official
 * path & fare planner (`plantrip`).
 *
 * Official planner sometimes 500s on specific ODs (code-gap adjacent pairs
 * like 1443→1445, some interchange ODs) while neighbouring ODs succeed.
 * Strategy — maximize recovered data, fail the city only on infra collapse:
 *
 * Segments (A→B adjacent on one line):
 *   1. Direct A→B, then reverse B→A
 *   2. Extract hop A→B from a longer official path (prev→B, A→next)
 *   3. Derive A→B ≈ total(prev→B) − total(prev→A) when paths are linear
 *
 * Transfers (approach → depart around a hub):
 *   1. Primary OD, then reverse
 *   2. Wider approach/depart neighbours (±2, ±3)
 *   3. Alternate official codes for multi-code stations
 *   4. Any successful path whose transferStationList hits the hub
 *
 * HTTP 302→error-page / 404 / 500 on an OD = official rejection (not fatal
 * by itself). Timeouts / connection errors = infra (retried; fatal only if
 * widespread). Derived times keep a distinct source_id for provenance.
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
const SOURCE_REVERSE = 'shmetro-plantrip-reverse';
const SOURCE_DERIVED = 'shmetro-plantrip-derived';
const SOURCE_ALT = 'shmetro-plantrip-alt';

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

type QueryOutcome =
  | { kind: 'ok'; path: PlantripPath | undefined }
  | { kind: 'rejected'; reason: string }
  | { kind: 'infra'; reason: string };

function minutesToSeconds(v: string | number | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : undefined;
}

function isOfficialOdError(status: number, location: string | null, bodyPreview: string): boolean {
  if (status === 404 || status === 500) return true;
  if (status >= 300 && status < 400) {
    const loc = location ?? '';
    return (
      loc.includes('500.html') ||
      loc.includes('aspxerrorpath') ||
      loc.includes('index.aspx') ||
      loc.includes('error')
    );
  }
  // HTML error page with 200 (proxy or origin)
  if (bodyPreview.startsWith('<') && status === 200) return true;
  return false;
}

/**
 * Query official plantrip. Classifies outcomes instead of throwing on every
 * OD-level rejection.
 */
async function queryPlantrip(startId: string, endId: string): Promise<QueryOutcome> {
  const url = proxyUrl(
    `https://m.shmetro.com/interface/plantrip/pt.aspx?func=plantrip&startId=${encodeURIComponent(
      startId
    )}&endId=${encodeURIComponent(endId)}&planTime=00:59&week=1&ticket=oneWay&type=0`
  );
  let lastInfra = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://m.shmetro.com/'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000)
      });
      const location = res.headers.get('location');
      if (!res.ok || (res.status >= 300 && res.status < 400)) {
        if (isOfficialOdError(res.status, location, '')) {
          // One retry for flaky proxy 404s, then treat as OD rejection.
          if (attempt < 1) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          return {
            kind: 'rejected',
            reason: location ? `redirect ${res.status}` : `HTTP ${res.status}`
          };
        }
        lastInfra = `HTTP ${res.status}`;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (text.startsWith('<')) {
        if (attempt < 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        return { kind: 'rejected', reason: 'html body' };
      }
      try {
        const j = JSON.parse(text) as { pathList?: PlantripPath[] };
        return { kind: 'ok', path: j.pathList?.[0] };
      } catch (err) {
        lastInfra = err instanceof Error ? err.message : String(err);
        await sleep(400 * 2 ** attempt);
      }
    } catch (err) {
      lastInfra = err instanceof Error ? err.message : String(err);
      await sleep(400 * 2 ** attempt);
    }
  }
  return { kind: 'infra', reason: lastInfra || 'unknown' };
}

/** Ride seconds for hop fromCode→toCode if they appear consecutively on the path. */
function hopSeconds(
  path: PlantripPath | undefined,
  fromCode: string,
  toCode: string
): number | undefined {
  const stops = path?.passStationList ?? [];
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].stationId === fromCode && stops[i + 1].stationId === toCode) {
      return minutesToSeconds(stops[i + 1].waitTime);
    }
  }
  return undefined;
}

function totalSeconds(path: PlantripPath | undefined): number | undefined {
  return minutesToSeconds(path?.time);
}

function transferSeconds(path: PlantripPath | undefined, hubName?: string): number | undefined {
  const hits = (path?.transferStationList ?? []).filter(
    (t) => minutesToSeconds(t.transferStationTime) != null
  );
  const hit = (hubName ? hits.find((h) => h.stationName === hubName) : undefined) ?? hits[0];
  return minutesToSeconds(hit?.transferStationTime);
}

/** Official codes walking `steps` from stopId along direction on the line. */
function walkCodes(
  patterns: PatternEncoded[],
  stopCode: (id: string) => string | undefined,
  stopId: string,
  direction: -1 | 1,
  maxSteps: number
): string[] {
  const out: string[] = [];
  let cur = stopId;
  for (let s = 1; s <= maxSteps; s++) {
    const next = neighbourStop(patterns, cur, direction);
    if (!next) break;
    const code = stopCode(next);
    if (code) out.push(code);
    cur = next;
  }
  return out;
}

type ResolvedTime = { seconds: number; source_id: string };

/**
 * Resolve one adjacent-segment ride time, trying direct / reverse /
 * longer-path extraction / linear derivation.
 */
async function resolveSegmentTime(
  aCode: string,
  bCode: string,
  prevCodes: string[],
  nextCodes: string[],
  stats: { queries: number; rejected: number; infra: number }
): Promise<ResolvedTime | undefined> {
  const track = async (a: string, b: string): Promise<QueryOutcome> => {
    stats.queries++;
    const r = await queryPlantrip(a, b);
    if (r.kind === 'rejected') stats.rejected++;
    if (r.kind === 'infra') stats.infra++;
    return r;
  };

  // 1) Direct
  const direct = await track(aCode, bCode);
  if (direct.kind === 'ok') {
    const h = hopSeconds(direct.path, aCode, bCode) ?? totalSeconds(direct.path);
    if (h != null && h > 0) return { seconds: h, source_id: SOURCE_ID };
  }

  // 2) Reverse
  const rev = await track(bCode, aCode);
  if (rev.kind === 'ok') {
    const h = hopSeconds(rev.path, bCode, aCode) ?? totalSeconds(rev.path);
    if (h != null && h > 0) return { seconds: h, source_id: SOURCE_REVERSE };
  }

  // 3) Longer official path that still contains consecutive A→B
  for (const p of prevCodes.slice(0, 2)) {
    const r = await track(p, bCode);
    if (r.kind !== 'ok') continue;
    const h = hopSeconds(r.path, aCode, bCode);
    if (h != null && h > 0) return { seconds: h, source_id: SOURCE_DERIVED };
  }
  for (const n of nextCodes.slice(0, 2)) {
    const r = await track(aCode, n);
    if (r.kind !== 'ok') continue;
    const h = hopSeconds(r.path, aCode, bCode);
    if (h != null && h > 0) return { seconds: h, source_id: SOURCE_DERIVED };
  }

  // 4) Linear derivation: total(P→B) − total(P→A) when both succeed
  for (const p of prevCodes.slice(0, 2)) {
    const rb = await track(p, bCode);
    if (rb.kind !== 'ok') continue;
    const tb = totalSeconds(rb.path);
    if (tb == null) continue;
    const ha = hopSeconds(rb.path, aCode, bCode);
    if (ha != null && ha > 0) return { seconds: ha, source_id: SOURCE_DERIVED };
    const ra = await track(p, aCode);
    if (ra.kind !== 'ok') continue;
    const ta = totalSeconds(ra.path);
    if (ta != null && tb > ta) {
      return { seconds: tb - ta, source_id: SOURCE_DERIVED };
    }
  }
  for (const n of nextCodes.slice(0, 2)) {
    const ra = await track(aCode, n);
    if (ra.kind !== 'ok') continue;
    const ta = totalSeconds(ra.path);
    if (ta == null) continue;
    const hb = hopSeconds(ra.path, aCode, bCode);
    if (hb != null && hb > 0) return { seconds: hb, source_id: SOURCE_DERIVED };
    const rb = await track(bCode, n);
    if (rb.kind !== 'ok') continue;
    const tb = totalSeconds(rb.path);
    if (tb != null && ta > tb) {
      return { seconds: ta - tb, source_id: SOURCE_DERIVED };
    }
  }

  return undefined;
}

export interface ShanghaiTimesInput {
  patterns: PatternEncoded[];
  stops: StopEncoded[];
  transfers: TransferEncoded[];
  /** stop_id → official per-line code used as plantrip startId/endId. */
  stopCode: (stopId: string) => string | undefined;
  /** station_id → Chinese display name, used to match transfer hits. */
  stationName?: (stationId: string) => string | undefined;
  /** station_id → every official map/slsddl code (multi-code hubs). */
  stationCodes?: (stationId: string) => string[];
  /** Last-resort walk seconds when official/hub samples are unavailable. */
  defaultWalkSeconds?: number;
  concurrency?: number;
  delayMs?: number;
}

export async function collectShanghaiPlannerTimes(input: ShanghaiTimesInput): Promise<{
  segments: HarvestedSegmentTime[];
  transfers: HarvestedTransferTime[];
  stats: {
    segmentQueries: number;
    segmentRejected: number;
    segmentInfra: number;
    segmentResolved: number;
    segmentDerived: number;
    transferQueries: number;
    transferRejected: number;
    transferInfra: number;
    transferResolved: number;
  };
}> {
  const concurrency = input.concurrency ?? 4;
  const delayMs = input.delayMs ?? 120;
  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const patterns = input.patterns;
  const stationCodes = input.stationCodes ?? (() => []);

  const stats = {
    segmentQueries: 0,
    segmentRejected: 0,
    segmentInfra: 0,
    segmentResolved: 0,
    segmentDerived: 0,
    transferQueries: 0,
    transferRejected: 0,
    transferInfra: 0,
    transferResolved: 0
  };

  // ── 1. Adjacent-stop segment times ────────────────────────────
  const pairs = adjacentStopPairs(input.patterns).filter((p) => {
    const a = input.stopCode(p.from_stop_id);
    const b = input.stopCode(p.to_stop_id);
    return a && b && stopById.get(p.from_stop_id)?.line_id === stopById.get(p.to_stop_id)?.line_id;
  });
  console.log(`  plantrip adjacent ODs: ${pairs.length}`);

  let segDone = 0;
  const unresolvedSeg: string[] = [];
  const infraSeg: string[] = [];

  const segResults = await mapPool(
    pairs,
    async (p) => {
      const a = input.stopCode(p.from_stop_id);
      const b = input.stopCode(p.to_stop_id);
      if (!a || !b) return undefined;
      const local = { queries: 0, rejected: 0, infra: 0 };
      const prevCodes = walkCodes(patterns, input.stopCode, p.from_stop_id, -1, 2);
      const nextCodes = walkCodes(patterns, input.stopCode, p.to_stop_id, 1, 2);
      try {
        const resolved = await resolveSegmentTime(a, b, prevCodes, nextCodes, local);
        stats.segmentQueries += local.queries;
        stats.segmentRejected += local.rejected;
        stats.segmentInfra += local.infra;
        if (!resolved) {
          unresolvedSeg.push(`${p.from_stop_id}->${p.to_stop_id} (${a}->${b})`);
          if (local.infra > 0 && local.rejected === 0) {
            infraSeg.push(`${a}->${b} infra=${local.infra}`);
          }
          return undefined;
        }
        stats.segmentResolved++;
        if (resolved.source_id !== SOURCE_ID) stats.segmentDerived++;
        return {
          from_stop_id: p.from_stop_id,
          to_stop_id: p.to_stop_id,
          travel_time_seconds: resolved.seconds,
          source_id: resolved.source_id
        } satisfies HarvestedSegmentTime;
      } finally {
        segDone++;
        if (segDone % 50 === 0) console.log(`    adjacent ${segDone}/${pairs.length}`);
      }
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
    fromStop: string;
    toStop: string;
  };
  const jobs: XferJob[] = [];
  for (const t of missing) {
    if (!t.from_stop_id || !t.to_stop_id) continue;
    jobs.push({
      station_id: t.station_id,
      from_line_id: t.from_line_id,
      to_line_id: t.to_line_id,
      hubName: input.stationName?.(t.station_id) ?? '',
      fromStop: t.from_stop_id,
      toStop: t.to_stop_id
    });
  }
  console.log(`  plantrip transfer ODs: ${jobs.length}`);

  const unresolvedXfer: string[] = [];

  async function resolveTransfer(job: XferJob): Promise<ResolvedTime | undefined> {
    const fromPatterns = patternsByLine.get(job.from_line_id) ?? patterns;
    const toPatterns = patternsByLine.get(job.to_line_id) ?? patterns;

    const startCodes: string[] = [];
    const endCodes: string[] = [];
    for (const steps of [1, 2, 3, 4]) {
      const approach = neighbourStop(fromPatterns, job.fromStop, -1, steps);
      const sc = approach ? input.stopCode(approach) : undefined;
      if (sc && !startCodes.includes(sc)) startCodes.push(sc);
      const depart = neighbourStop(toPatterns, job.toStop, 1, steps);
      const ec = depart ? input.stopCode(depart) : undefined;
      if (ec && !endCodes.includes(ec)) endCodes.push(ec);
    }
    // Multi-code hubs: other official codes for the hub stations themselves
    // (used as OD endpoints when neighbour walk is exhausted).
    for (const c of stationCodes(job.station_id)) {
      if (c && !endCodes.includes(c) && endCodes.length < 6) endCodes.push(c);
    }
    // Cap combinations — each extra OD is another chance at official 500.
    const starts = startCodes.slice(0, 3);
    const ends = endCodes.slice(0, 4);

    const tryPair = async (
      s: string,
      e: string,
      source: string
    ): Promise<ResolvedTime | undefined> => {
      stats.transferQueries++;
      const r = await queryPlantrip(s, e);
      if (r.kind === 'rejected') stats.transferRejected++;
      if (r.kind === 'infra') stats.transferInfra++;
      if (r.kind !== 'ok') return undefined;
      const sec = transferSeconds(r.path, job.hubName);
      if (sec != null && sec > 0) return { seconds: sec, source_id: source };
      return undefined;
    };

    // Primary + reverse on first pair
    if (starts[0] && ends[0]) {
      const hit = await tryPair(starts[0], ends[0], SOURCE_ID);
      if (hit) return hit;
      const rev = await tryPair(ends[0], starts[0], SOURCE_REVERSE);
      if (rev) return rev;
    }

    // Wider neighbour / alternate code combinations
    for (const s of starts) {
      for (const e of ends) {
        if (s === starts[0] && e === ends[0]) continue;
        const hit = await tryPair(s, e, SOURCE_ALT);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  let xferDone = 0;
  const xferResults = await mapPool(
    jobs,
    async (job) => {
      try {
        const resolved = await resolveTransfer(job);
        if (!resolved) {
          unresolvedXfer.push(`${job.station_id} ${job.from_line_id}->${job.to_line_id}`);
          return undefined;
        }
        stats.transferResolved++;
        return {
          station_id: job.station_id,
          from_line_id: job.from_line_id,
          to_line_id: job.to_line_id,
          walk_time_seconds: resolved.seconds,
          source_id: resolved.source_id
        } satisfies HarvestedTransferTime;
      } finally {
        xferDone++;
        if (xferDone % 25 === 0) console.log(`    transfer ${xferDone}/${jobs.length}`);
      }
    },
    { concurrency, delayMs }
  );
  const transfers = xferResults.filter((x): x is HarvestedTransferTime => x != null);

  // ── 3. Derive remaining transfer walks ─────────────────────────
  // Official plantrip often lists an interchange without transferStationTime.
  // Reuse reverse-pair / same-hub official minutes when available — walk time
  // at a station is effectively undirected.
  const xferByKey = new Map<string, HarvestedTransferTime>();
  const hubSamples = new Map<string, number[]>();
  const noteHub = (stationId: string, seconds: number) => {
    const arr = hubSamples.get(stationId) ?? [];
    arr.push(seconds);
    hubSamples.set(stationId, arr);
  };
  const recordXfer = (t: HarvestedTransferTime) => {
    if (!(t.walk_time_seconds > 0)) return;
    xferByKey.set(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`, t);
    noteHub(t.station_id, t.walk_time_seconds);
  };
  for (const t of input.transfers) {
    if (t.walk_time_seconds != null) {
      noteHub(t.station_id, t.walk_time_seconds);
    }
  }
  for (const t of transfers) recordXfer(t);

  let derivedTransfers = 0;
  const stillUnresolved: typeof unresolvedXfer = [];
  for (const job of jobs) {
    const key = `${job.station_id}|${job.from_line_id}|${job.to_line_id}`;
    if (xferByKey.has(key)) continue;
    const rev = xferByKey.get(`${job.station_id}|${job.to_line_id}|${job.from_line_id}`);
    if (rev?.walk_time_seconds) {
      const filled: HarvestedTransferTime = {
        station_id: job.station_id,
        from_line_id: job.from_line_id,
        to_line_id: job.to_line_id,
        walk_time_seconds: rev.walk_time_seconds,
        source_id: SOURCE_DERIVED
      };
      transfers.push(filled);
      recordXfer(filled);
      derivedTransfers++;
      continue;
    }
    const samples = hubSamples.get(job.station_id);
    if (samples?.length) {
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)];
      if (mid > 0) {
        const filled: HarvestedTransferTime = {
          station_id: job.station_id,
          from_line_id: job.from_line_id,
          to_line_id: job.to_line_id,
          walk_time_seconds: mid,
          source_id: SOURCE_DERIVED
        };
        transfers.push(filled);
        recordXfer(filled);
        derivedTransfers++;
        continue;
      }
    }
    // Network-level default — official planner omits some interchange minutes
    // entirely (e.g. 3/4 宝山路). Prefer a published default over null so
    // routing stays connected; provenance stays `*-derived`.
    if (input.defaultWalkSeconds && input.defaultWalkSeconds > 0) {
      const filled: HarvestedTransferTime = {
        station_id: job.station_id,
        from_line_id: job.from_line_id,
        to_line_id: job.to_line_id,
        walk_time_seconds: input.defaultWalkSeconds,
        source_id: SOURCE_DERIVED
      };
      transfers.push(filled);
      recordXfer(filled);
      derivedTransfers++;
      continue;
    }
    stillUnresolved.push(`${job.station_id} ${job.from_line_id}->${job.to_line_id}`);
  }

  console.log(
    `  plantrip harvest: ${segments.length}/${pairs.length} segments (${stats.segmentDerived} via fallback), ` +
      `${transfers.length}/${jobs.length} transfers (${derivedTransfers} derived from hub/reverse)`
  );
  console.log(
    `  plantrip queries=${stats.segmentQueries + stats.transferQueries} ` +
      `od_rejected=${stats.segmentRejected + stats.transferRejected} ` +
      `infra=${stats.segmentInfra + stats.transferInfra}`
  );
  if (unresolvedSeg.length) {
    console.log(
      `  unresolved segments (${unresolvedSeg.length}): ${unresolvedSeg.slice(0, 12).join(', ')}${unresolvedSeg.length > 12 ? '…' : ''}`
    );
  }
  if (stillUnresolved.length) {
    console.log(
      `  unresolved transfers (${stillUnresolved.length}): ${stillUnresolved.slice(0, 12).join(', ')}${stillUnresolved.length > 12 ? '…' : ''}`
    );
  }

  // Fail only on infrastructure collapse or when a large share of edges stay
  // unresolved — OD-level official 500s after fallbacks are not fatal.
  const totalEdges = pairs.length + jobs.length;
  const unresolved = unresolvedSeg.length + stillUnresolved.length;
  const infraTotal = stats.segmentInfra + stats.transferInfra;
  const queriesTotal = stats.segmentQueries + stats.transferQueries;
  const infraRate = queriesTotal > 0 ? infraTotal / queriesTotal : 0;
  const unresolvedRate = totalEdges > 0 ? unresolved / totalEdges : 0;

  if (infraRate > 0.25) {
    throw new Error(
      `Shanghai plantrip infra failure rate ${(infraRate * 100).toFixed(1)}% ` +
        `(${infraTotal}/${queriesTotal}); refusing to publish partial harvest`
    );
  }
  if (unresolvedRate > 0.2) {
    throw new Error(
      `Shanghai plantrip left ${(unresolvedRate * 100).toFixed(1)}% of edges unresolved ` +
        `(${unresolved}/${totalEdges}); refusing to publish partial harvest\n` +
        `  segments: ${unresolvedSeg.slice(0, 20).join('; ')}\n` +
        `  transfers: ${stillUnresolved.slice(0, 20).join('; ')}`
    );
  }

  return { segments, transfers, stats };
}
