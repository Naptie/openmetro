/**
 * Adapter-agnostic `gapfill` sync layer.
 *
 * Upgrades weak segment times / missing distances / missing-or-default
 * transfer walks using the Baidu transit planner (city operators may
 * reverse-proxy the same API — see `baidu.ts`). Never overwrites
 * `travel_time_source: "source"` or an existing `planner` harvest from the
 * operator's own route planner.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncCtx } from '../adapter/contract.js';
import {
  adjacentStopPairs,
  type HarvestedSegmentTime,
  type HarvestedTransferTime,
  mapPool,
  neighbourStop
} from '../times/harvest.js';
import {
  BAIDU_SOURCE_ID,
  type BaiduLatLng,
  BaiduPlannerClient,
  type BaiduTransitStep,
  loadBaiduGapfillConfig,
  pathMeters,
  pureMetroSteps
} from './baidu.js';
import { bd09ToGcj02 } from '../geocode/overpass.js';

type Id = string;

interface SegmentRow {
  id: string;
  line_id: string;
  from_stop_id: string;
  to_stop_id: string;
  from_station_id: string;
  to_station_id: string;
  travel_time_seconds?: number;
  travel_time_source?: string;
  travel_time_derived_from?: string[];
  distance_km?: number;
  source_id?: string;
  extras?: Record<string, unknown>;
}

interface TransferRow {
  id: string;
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  from_stop_id?: string;
  to_stop_id?: string;
  walk_time_seconds?: number | null;
  walk_distance_meters?: number | null;
  source_id?: string;
  extras?: Record<string, unknown>;
}

interface StopRow {
  id: string;
  station_id: string;
  line_id: string;
}

interface PatternRow {
  id: string;
  line_id: string;
  stop_ids: string[];
}

interface StationRow {
  id: string;
  name?: string;
  names?: { zh?: string };
  location?: { lon?: number; lat?: number; crs?: string };
  extras?: Record<string, unknown>;
}

interface CanonicalDoc<T> {
  $schema: string;
  schema_version: string;
  network_id: string;
  generated_at: string;
  source: unknown[];
  records: T[];
}

export interface GapfillResult {
  coordinatesFilled: number;
  segmentTimesFilled: number;
  segmentDistancesFilled: number;
  transferWalksFilled: number;
  queries: number;
  failures: string[];
}

function isWeakSegmentTime(s: SegmentRow): boolean {
  if (s.travel_time_seconds == null || !(s.travel_time_seconds > 0)) return true;
  return s.travel_time_source === 'last_train' || s.travel_time_source === 'estimated';
}

function needsDistance(s: SegmentRow): boolean {
  return s.distance_km == null || !(s.distance_km > 0);
}

function needsWalk(t: TransferRow, defaultWalk: number): boolean {
  if (t.walk_time_seconds == null) return true;
  if (t.walk_time_seconds === defaultWalk) return true;
  return /default/i.test(t.source_id ?? '');
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function loadDoc<T>(path: string): Promise<CanonicalDoc<T>> {
  return JSON.parse(await readFile(path, 'utf-8')) as CanonicalDoc<T>;
}

async function saveDoc<T>(path: string, doc: CanonicalDoc<T>): Promise<void> {
  doc.generated_at = new Date().toISOString();
  const hasSource = doc.source.some((s) => JSON.stringify(s).includes('baidu'));
  if (!hasSource) {
    doc.source.push({
      name: 'Baidu Direction Lite transit',
      url: 'https://api.map.baidu.com/directionlite/v1/transit',
      version: '1',
      retrieved_at: new Date().toISOString(),
      license: 'custom',
      license_url: null,
      attribution: 'Baidu Maps',
      notes:
        'Third-party route planner used only to gap-fill weak/missing segment times, distances and transfer walks. Official operator values are never overwritten.'
    });
  }
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
}

function stationLabel(st: StationRow | undefined): string {
  if (!st) return '';
  const baidu = st.extras?.baidu_station_name;
  if (typeof baidu === 'string' && baidu) return baidu.replace(/站$/, '');
  const zh = st.names?.zh || st.name || '';
  return zh.replace(/站$/, '');
}

/**
 * Station coordinate for the Baidu planner, in the canonical datum.
 *
 * Canonical data is GCJ-02 (CN) / WGS-84 (ex-CN) — never persist BD-09.
 * `BaiduPlannerClient.transit` takes this pair and converts to BD-09 only
 * for the HTTP request. Converting here as well double-twists the point and
 * the planner returns bus/wrong-area routes.
 */
function stationGcj(st: StationRow | undefined): BaiduLatLng | undefined {
  const loc = st?.location;
  if (!loc || loc.lon == null || loc.lat == null) return undefined;
  // Defensive: fold any leaked BD-09 back to GCJ-02 before the planner call.
  if (loc.crs === 'bd09') {
    const gcj = bd09ToGcj02(loc.lon, loc.lat);
    return { lng: gcj.lon, lat: gcj.lat };
  }
  return { lng: loc.lon, lat: loc.lat };
}

function normName(s: string | undefined): string {
  return (s ?? '')
    .replace(/站.*$/, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim();
}

function nameMatches(hay: string, needle: string): boolean {
  if (!hay || !needle) return false;
  return hay === needle || hay.includes(needle) || needle.includes(hay);
}

function nearestRideHop(
  steps: BaiduTransitStep[],
  fromName: string,
  toName: string
): { duration?: number; distance?: number; path?: string } | undefined {
  const a = normName(fromName);
  const b = normName(toName);
  for (const s of steps) {
    if (s.type !== 3) continue;
    const v = s.vehicle ?? {};
    const sn = normName(v.start_name);
    const en = normName(v.end_name);
    const mid = (v.stop_info ?? []).map((x) => normName(x.stop_name));
    const names = [sn, en, ...mid];
    const hasA = names.some((n) => nameMatches(n, a));
    const hasB = names.some((n) => nameMatches(n, b));
    if (!hasA || !hasB) continue;
    return { duration: s.duration, distance: s.distance, path: s.path };
  }
  const rides = steps.filter((s) => s.type === 3);
  if (rides.length === 1) {
    const s = rides[0];
    return { duration: s.duration, distance: s.distance, path: s.path };
  }
  return undefined;
}

function walkBetweenRides(
  steps: BaiduTransitStep[],
  hub?: { lon: number; lat: number }
): { duration?: number; distance?: number; score?: number } | undefined {
  type Hit = {
    duration?: number;
    distance?: number;
    score: number;
  };
  const hits: Hit[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type !== 5) continue;
    const prev = steps[i - 1];
    const next = steps[i + 1];
    if (!prev || prev.type !== 3 || !next || next.type !== 3) continue;
    const w = steps[i] as {
      duration?: number;
      distance?: number;
      start_location?: { lng?: number; lat?: number };
      end_location?: { lng?: number; lat?: number };
    };
    // Default: first mid-route walk. When a hub is given, prefer the walk whose
    // endpoints sit at that station — multi-transfer itineraries otherwise
    // attribute e.g. 五一公园's concourse walk to 郑州火车站.
    let score = hits.length;
    if (hub) {
      const pts = [w.start_location, w.end_location].filter(
        (p): p is { lng?: number; lat?: number } =>
          p != null && Number.isFinite(p.lng) && Number.isFinite(p.lat)
      );
      if (pts.length > 0) {
        let dMin = Number.POSITIVE_INFINITY;
        for (const p of pts) {
          const dLon = ((p.lng as number) - hub.lon) * Math.cos((hub.lat * Math.PI) / 180);
          const dLat = (p.lat as number) - hub.lat;
          const d = Math.sqrt(dLon * dLon + dLat * dLat);
          if (d < dMin) dMin = d;
        }
        score = dMin;
      }
    }
    hits.push({ duration: w.duration, distance: w.distance, score });
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => a.score - b.score);
  return { duration: hits[0].duration, distance: hits[0].distance, score: hits[0].score };
}

/**
 * Fill gaps in `segments.json` + `transfers.json` under `dataDir`.
 * Safe to run on any network that already has canonical topology.
 */

const BAIDU_PLACE_SOURCE = 'baidu-place';

interface PlaceHit {
  name: string;
  uid?: string;
  location?: { lng: number; lat: number };
  address?: string;
}

/**
 * Baidu Place search. `ret_coordtype=gcj02` keeps the result in the canonical
 * datum (never store BD-09). Used only for stations the AMap/Overpass/Photon
 * chain could not place.
 */
async function baiduPlaceSearch(
  query: string,
  region: string,
  ak: string
): Promise<PlaceHit[]> {
  const url =
    `https://api.map.baidu.com/place/v2/search?query=${encodeURIComponent(query)}` +
    `&region=${encodeURIComponent(region)}&output=json&ret_coordtype=gcj02&page_size=10&ak=${encodeURIComponent(ak)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*'
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`place search HTTP ${res.status}`);
  const body = (await res.json()) as {
    status?: number;
    message?: string;
    results?: PlaceHit[];
  };
  if (typeof body.status === 'number' && body.status !== 0) return [];
  return body.results ?? [];
}

function placeNameScore(needle: string, hit: PlaceHit): number {
  const n = needle.replace(/站$/, '').trim();
  const h = (hit.name ?? '').replace(/站$/, '').trim();
  if (!n || !h) return 0;
  // Demote exits / doors / annexes so the station POI itself wins.
  if (/[出入口口]$/.test(h) || /[出入口]|门$|口$/.test(h)) return 10;
  if (h === n) return 100;
  if (h.includes(n) || n.includes(h)) return 80;
  if (n.includes(h) || h.includes(n.slice(0, 2))) return 40;
  return 0;
}

export async function runGapfill(ctx: SyncCtx): Promise<GapfillResult> {
  const loaded = loadBaiduGapfillConfig();
  if ('error' in loaded) {
    throw new Error(loaded.error);
  }
  const client = new BaiduPlannerClient(loaded);
  const dataDir = ctx.dataDir;

  const netDoc = JSON.parse(await readFile(join(dataDir, 'network.json'), 'utf-8')) as {
    routing?: { default_transfer_seconds?: number };
    city?: { name?: { zh?: string; en?: string } };
    name?: string;
  };
  const defaultWalk = netDoc.routing?.default_transfer_seconds ?? 120;
  const cityLabel =
    netDoc.city?.name?.zh || netDoc.name?.replace(/地铁$/, '') || netDoc.name || '';

  const stationsDoc = await loadDoc<StationRow>(join(dataDir, 'stations.json'));
  const stopsDoc = await loadDoc<StopRow>(join(dataDir, 'stops.json'));
  const patternsDoc = await loadDoc<PatternRow>(join(dataDir, 'patterns.json'));
  const segmentsDoc = await loadDoc<SegmentRow>(join(dataDir, 'segments.json'));
  const transfersDoc = await loadDoc<TransferRow>(join(dataDir, 'transfers.json'));

  const stations = new Map(stationsDoc.records.map((s) => [s.id, s]));
  const stopStation = new Map<Id, Id>(stopsDoc.records.map((s) => [s.id, s.station_id]));

  const failures: string[] = [];

  // ── 0. Missing station coordinates (AMap/Overpass/Photon misses) ──
  // The geocode chain runs in topology sync; gapfill is the last chance to
  // place leftovers via Baidu Place (GCJ-02 in, GCJ-02 out).
  let coordsFilled = 0;
  const missingCoords = stationsDoc.records.filter((s) => {
    const loc = s.location;
    return !loc || loc.lon == null || loc.lat == null;
  });
  if (missingCoords.length > 0 && cityLabel) {
    console.log(`  gapfill missing coordinates: ${missingCoords.length} (Baidu Place)`);
    for (const st of missingCoords) {
      const zh = st.names?.zh || st.name || '';
      const queries = [zh, zh.replace(/站$/, ''), `${zh.replace(/站$/, '')}地铁站`];
      try {
        let best: { hit: PlaceHit; score: number } | undefined;
        for (const q of queries) {
          const hits = await baiduPlaceSearch(q, cityLabel, loaded.ak);
          for (const hit of hits) {
            if (!hit.location?.lng || !hit.location?.lat) continue;
            let score = placeNameScore(zh, hit);
            const addr = `${hit.address ?? ''} ${hit.name ?? ''}`;
            if (/地铁|轨道/.test(addr)) score += 25;
            if (!best || score > best.score) best = { hit, score };
          }
          if (best && best.score >= 80) break;
          await new Promise((r) => setTimeout(r, Math.ceil(1000 / loaded.qps)));
        }
        if (best && best.score >= 40 && best.hit.location) {
          st.location = {
            lon: best.hit.location.lng,
            lat: best.hit.location.lat,
            crs: 'gcj02'
          };
          st.extras = {
            ...(st.extras ?? {}),
            location_source: BAIDU_PLACE_SOURCE,
            baidu_place_uid: best.hit.uid,
            baidu_place_name: best.hit.name
          };
          coordsFilled++;
          console.log(`    coord ${zh} <- ${best.hit.name} ${best.hit.location.lng},${best.hit.location.lat}`);
        } else {
          failures.push(`coord ${zh}: no confident Baidu Place hit`);
        }
      } catch (err) {
        failures.push(
          `coord ${zh}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (coordsFilled > 0) {
      await saveDoc(join(dataDir, 'stations.json'), stationsDoc);
    }
  }

  // ── 1. Transfer walks (null / baked default) ──
  const patternsByLine = new Map<string, PatternRow[]>();
  for (const p of patternsDoc.records) {
    const arr = patternsByLine.get(p.line_id) ?? [];
    arr.push(p);
    patternsByLine.set(p.line_id, arr);
  }

  type XferCandidate = { from_station: string; to_station: string };
  type XferJob = {
    transfers: TransferRow[];
    /** Ordered OD tries: tightest hop first, then wider spans (Baidu often
     * returns bus-only for ±1 hops and metro for ±2). */
    candidates: XferCandidate[];
  };

  /** Candidate approach/depart spans around a transfer hub. */
  const XFER_SPANS: [number, number][] = [
    [-1, 1],
    [-2, 2],
    [-1, 2],
    [-2, 1],
    [1, -1],
    [2, -2],
    [1, -2],
    [2, -1],
    [-1, -1],
    [-2, -2],
    [1, -3],
    [2, -3],
    [-2, -3],
    [-3, -1],
    [-3, -2],
    [-3, 1],
    [3, -1],
    [3, -2],
    [1, -4],
    [-3, -3],
    [3, -3],
    [-4, -2]
  ];

  const xferJobs: XferJob[] = [];
  const xferByTransfer = new Map<string, XferJob>();
  for (const t of transfersDoc.records) {
    if (!needsWalk(t, defaultWalk)) continue;
    if (!t.from_stop_id || !t.to_stop_id) continue;
    const fromPatterns = patternsByLine.get(t.from_line_id) ?? patternsDoc.records;
    const toPatterns = patternsByLine.get(t.to_line_id) ?? patternsDoc.records;
    const candidates: XferCandidate[] = [];
    const seen = new Set<string>();
    for (const [da, db] of XFER_SPANS) {
      const approach = neighbourStop(fromPatterns, t.from_stop_id, da < 0 ? -1 : 1, Math.abs(da));
      const depart = neighbourStop(toPatterns, t.to_stop_id, db < 0 ? -1 : 1, Math.abs(db));
      if (!approach || !depart) continue;
      const aSt = stopStation.get(approach);
      const bSt = stopStation.get(depart);
      if (!aSt || !bSt) continue;
      const k = pairKey(aSt, bSt);
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push({ from_station: aSt, to_station: bSt });
    }
    if (candidates.length === 0) continue;
    const jobKey = `${t.station_id}|${t.from_line_id}|${t.to_line_id}`;
    const existing = xferByTransfer.get(jobKey);
    if (existing) {
      existing.transfers.push(t);
      continue;
    }
    const job: XferJob = { transfers: [t], candidates };
    xferByTransfer.set(jobKey, job);
    xferJobs.push(job);
  }

  console.log(`  gapfill transfer ODs: ${xferJobs.length}`);
  const harvestedWalks: HarvestedTransferTime[] = [];
  const harvestedWalkM = new Map<string, number>();
  let xDone = 0;
  await mapPool(
    xferJobs,
    async (job) => {
      if (client.exhausted) return;
      try {
        for (const cand of job.candidates) {
          const o = stationGcj(stations.get(cand.from_station));
          const d = stationGcj(stations.get(cand.to_station));
          if (!o || !d) continue;
          const resp = await client.transit(o, d);
          const hubLoc = (() => {
            const hs = stations.get(job.transfers[0]?.station_id ?? '');
            const loc = hs?.location;
            if (!loc || loc.lon == null || loc.lat == null) return undefined;
            return { lon: loc.lon, lat: loc.lat };
          })();
          // Scan every route and keep the walk nearest the hub — the first
          // "any transfer" route often walks at a different interchange
          // (e.g. 五一公园 L1/L5) and must not win over the real hub.
          let walk: { duration?: number; distance?: number } | undefined;
          let bestScore = Number.POSITIVE_INFINITY;
          for (const route of resp?.result?.routes ?? []) {
            const st = pureMetroSteps(route.steps);
            if (st.length < 3) continue;
            const w = walkBetweenRides(st, hubLoc);
            if (!(w?.duration && w.duration > 0)) continue;
            if (w.duration < 15 || w.duration > 720) continue;
            const score = (w as { score?: number }).score ?? 0;
            if (score < bestScore) {
              bestScore = score;
              walk = w;
            }
          }
          if (!walk) continue;
          for (const t of job.transfers) {
            harvestedWalks.push({
              station_id: t.station_id,
              from_line_id: t.from_line_id,
              to_line_id: t.to_line_id,
              walk_time_seconds: Math.round(walk.duration as number),
              source_id: BAIDU_SOURCE_ID
            });
            if (walk.distance != null && walk.distance > 0) {
              harvestedWalkM.set(
                `${t.station_id}|${t.from_line_id}|${t.to_line_id}`,
                Math.round(walk.distance as number)
              );
            }
          }
          break;
        }
      } catch (err) {
        failures.push(
          `transfer ${job.candidates[0]?.from_station}->${job.candidates[0]?.to_station}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        xDone++;
        if (xDone % 30 === 0) console.log(`    transfer ${xDone}/${xferJobs.length}`);
      }
    },
    { concurrency: 2, delayMs: Math.ceil(1000 / loaded.qps) }
  );

  let walkFilled = 0;
  const walkBy = new Map<string, HarvestedTransferTime>();
  for (const h of harvestedWalks) {
    const k = `${h.station_id}|${h.from_line_id}|${h.to_line_id}`;
    if (!walkBy.has(k)) walkBy.set(k, h);
  }
  for (const t of transfersDoc.records) {
    if (!needsWalk(t, defaultWalk)) continue;
    const k = `${t.station_id}|${t.from_line_id}|${t.to_line_id}`;
    const hit = walkBy.get(k);
    if (!hit) continue;
    t.walk_time_seconds = hit.walk_time_seconds;
    t.source_id = hit.source_id;
    const dm = harvestedWalkM.get(k);
    if (dm != null) t.walk_distance_meters = dm;
    t.extras = { ...(t.extras ?? {}), walk_source: BAIDU_SOURCE_ID };
    walkFilled++;
  }

  // ── 2. Weak / missing segment times + distances ──
  const needSeg = segmentsDoc.records.filter((s) => isWeakSegmentTime(s) || needsDistance(s));
  const segByPair = new Map<string, SegmentRow[]>();
  for (const s of needSeg) {
    const k = pairKey(s.from_stop_id, s.to_stop_id);
    const arr = segByPair.get(k) ?? [];
    arr.push(s);
    segByPair.set(k, arr);
  }

  type SegJob = {
    segs: SegmentRow[];
    from_station: string;
    to_station: string;
    from_label: string;
    to_label: string;
  };
  const segJobs: SegJob[] = [];
  const jobByStationPair = new Map<string, SegJob>();
  for (const p of adjacentStopPairs(patternsDoc.records)) {
    const segs = segByPair.get(pairKey(p.from_stop_id, p.to_stop_id));
    if (!segs || segs.length === 0) continue;
    const fromSt = stopStation.get(p.from_stop_id);
    const toSt = stopStation.get(p.to_stop_id);
    if (!fromSt || !toSt) continue;
    const k = pairKey(fromSt, toSt);
    const existing = jobByStationPair.get(k);
    if (existing) {
      existing.segs.push(...segs);
      continue;
    }
    const job: SegJob = {
      segs: [...segs],
      from_station: fromSt,
      to_station: toSt,
      from_label: stationLabel(stations.get(fromSt)),
      to_label: stationLabel(stations.get(toSt))
    };
    jobByStationPair.set(k, job);
    segJobs.push(job);
  }

  console.log(`  gapfill segment ODs: ${segJobs.length} (cap ${loaded.maxQueries ?? '∞'})`);
  const harvestedSegs: HarvestedSegmentTime[] = [];
  const harvestedDist = new Map<string, number>();
  let segDone = 0;
  await mapPool(
    segJobs,
    async (job) => {
      if (client.exhausted) return;
      try {
        const o = stationGcj(stations.get(job.from_station));
        const d = stationGcj(stations.get(job.to_station));
        if (!o || !d) return;
        const resp = await client.transit(o, d);
        let dur: number | undefined;
        let meters: number | undefined;
        for (const route of resp?.result?.routes ?? []) {
          const st = pureMetroSteps(route.steps);
          if (st.length === 0) continue;
          const hit = nearestRideHop(st, job.from_label, job.to_label);
          if (hit?.duration && hit.duration > 0) {
            dur = hit.duration;
            meters = hit.distance ?? pathMeters(hit.path);
            break;
          }
        }
        for (const seg of job.segs) {
          const key = pairKey(seg.from_stop_id, seg.to_stop_id);
          if (dur != null && dur > 0 && isWeakSegmentTime(seg)) {
            harvestedSegs.push({
              from_stop_id: seg.from_stop_id,
              to_stop_id: seg.to_stop_id,
              travel_time_seconds: Math.round(dur),
              source_id: BAIDU_SOURCE_ID
            });
          }
          if (meters != null && meters > 0 && needsDistance(seg)) {
            harvestedDist.set(key, meters);
          }
        }
      } catch (err) {
        failures.push(
          `segment ${job.from_station}->${job.to_station}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        segDone++;
        if (segDone % 50 === 0) console.log(`    segment ${segDone}/${segJobs.length}`);
      }
    },
    { concurrency: 2, delayMs: Math.ceil(1000 / loaded.qps) }
  );

  let segTimeFilled = 0;
  const byPair = new Map<string, HarvestedSegmentTime>();
  for (const h of harvestedSegs) {
    const k = pairKey(h.from_stop_id, h.to_stop_id);
    if (!byPair.has(k)) byPair.set(k, h);
  }
  for (const s of segmentsDoc.records) {
    if (!isWeakSegmentTime(s)) continue;
    const hit = byPair.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!hit) continue;
    s.travel_time_seconds = hit.travel_time_seconds;
    s.travel_time_source = 'planner';
    s.travel_time_derived_from = undefined;
    s.source_id = s.source_id ?? hit.source_id;
    s.extras = { ...(s.extras ?? {}), planner_time_source: hit.source_id };
    segTimeFilled++;
  }

  let segDistFilled = 0;
  for (const s of segmentsDoc.records) {
    if (!needsDistance(s)) continue;
    const m = harvestedDist.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!(m && m > 0)) continue;
    s.distance_km = Math.round((m / 1000) * 1000) / 1000;
    s.extras = {
      ...(s.extras ?? {}),
      distance_source: 'baidu_path',
      distance_meters: Math.round(m)
    };
    segDistFilled++;
  }

  if (segTimeFilled + segDistFilled > 0) {
    await saveDoc(join(dataDir, 'segments.json'), segmentsDoc);
  }
  if (walkFilled > 0) {
    await saveDoc(join(dataDir, 'transfers.json'), transfersDoc);
  }

  console.log(
    `  gapfill: +${coordsFilled} coordinates, +${segTimeFilled} segment times, ` +
      `+${segDistFilled} distances, +${walkFilled} transfer walks ` +
      `(${client.queries} queries, ${failures.length} failures)`
  );
  if (failures.length > 0) {
    console.warn(
      `  gapfill failures (${failures.length}):\n  - ${failures.slice(0, 15).join('\n  - ')}${
        failures.length > 15 ? `\n  … and ${failures.length - 15} more` : ''
      }`
    );
  }
  return {
    coordinatesFilled: coordsFilled,
    segmentTimesFilled: segTimeFilled,
    segmentDistancesFilled: segDistFilled,
    transferWalksFilled: walkFilled,
    queries: client.queries,
    failures
  };
}
