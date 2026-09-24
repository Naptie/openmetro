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
  BaiduPlannerClient,
  gcj02ToBd09,
  loadBaiduGapfillConfig,
  pathMeters,
  pureMetroSteps,
  type BaiduLatLng,
  type BaiduTransitStep
} from './baidu.js';

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

function stationGcj(st: StationRow | undefined): BaiduLatLng | undefined {
  const loc = st?.location;
  if (!loc || loc.lon == null || loc.lat == null) return undefined;
  // Baidu planner expects BD-09; convert GCJ-02 canonical coords. If the
  // station is already BD-09, pass through.
  if (loc.crs === 'bd09') return { lng: loc.lon, lat: loc.lat };
  return gcj02ToBd09(loc.lat, loc.lon);
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
  steps: BaiduTransitStep[]
): { duration?: number; distance?: number } | undefined {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type !== 5) continue;
    const prev = steps[i - 1];
    const next = steps[i + 1];
    if (!prev || prev.type !== 3 || !next || next.type !== 3) continue;
    return { duration: steps[i].duration, distance: steps[i].distance };
  }
  return undefined;
}

/**
 * Fill gaps in `segments.json` + `transfers.json` under `dataDir`.
 * Safe to run on any network that already has canonical topology.
 */
export async function runGapfill(ctx: SyncCtx): Promise<GapfillResult> {
  const loaded = loadBaiduGapfillConfig();
  if ('error' in loaded) {
    throw new Error(loaded.error);
  }
  const client = new BaiduPlannerClient(loaded);
  const dataDir = ctx.dataDir;

  const netDoc = JSON.parse(await readFile(join(dataDir, 'network.json'), 'utf-8')) as {
    routing?: { default_transfer_seconds?: number };
  };
  const defaultWalk = netDoc.routing?.default_transfer_seconds ?? 120;

  const stationsDoc = await loadDoc<StationRow>(join(dataDir, 'stations.json'));
  const stopsDoc = await loadDoc<StopRow>(join(dataDir, 'stops.json'));
  const patternsDoc = await loadDoc<PatternRow>(join(dataDir, 'patterns.json'));
  const segmentsDoc = await loadDoc<SegmentRow>(join(dataDir, 'segments.json'));
  const transfersDoc = await loadDoc<TransferRow>(join(dataDir, 'transfers.json'));

  const stations = new Map(stationsDoc.records.map((s) => [s.id, s]));
  const stopStation = new Map<Id, Id>(stopsDoc.records.map((s) => [s.id, s.station_id]));

  const failures: string[] = [];

  // ── 1. Transfer walks (null / baked default) ──
  const patternsByLine = new Map<string, PatternRow[]>();
  for (const p of patternsDoc.records) {
    const arr = patternsByLine.get(p.line_id) ?? [];
    arr.push(p);
    patternsByLine.set(p.line_id, arr);
  }

  type XferJob = {
    transfers: TransferRow[];
    from_station: string;
    to_station: string;
  };
  const xferJobs: XferJob[] = [];
  const xferByOD = new Map<string, XferJob>();
  for (const t of transfersDoc.records) {
    if (!needsWalk(t, defaultWalk)) continue;
    if (!t.from_stop_id || !t.to_stop_id) continue;
    const fromPatterns = patternsByLine.get(t.from_line_id) ?? patternsDoc.records;
    const toPatterns = patternsByLine.get(t.to_line_id) ?? patternsDoc.records;
    const approach = neighbourStop(fromPatterns, t.from_stop_id, -1);
    const depart = neighbourStop(toPatterns, t.to_stop_id, 1);
    if (!approach || !depart) continue;
    const aSt = stopStation.get(approach);
    const bSt = stopStation.get(depart);
    if (!aSt || !bSt) continue;
    const k = pairKey(aSt, bSt);
    const existing = xferByOD.get(k);
    if (existing) {
      existing.transfers.push(t);
      continue;
    }
    const job: XferJob = { transfers: [t], from_station: aSt, to_station: bSt };
    xferByOD.set(k, job);
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
        const o = stationGcj(stations.get(job.from_station));
        const d = stationGcj(stations.get(job.to_station));
        if (!o || !d) return;
        const resp = await client.transit(o, d);
        for (const route of resp?.result?.routes ?? []) {
          const st = pureMetroSteps(route.steps);
          if (st.length < 3) continue;
          const walk = walkBetweenRides(st);
          if (!(walk?.duration && walk.duration > 0)) continue;
          if (walk.duration < 15 || walk.duration > 720) continue;
          for (const t of job.transfers) {
            harvestedWalks.push({
              station_id: t.station_id,
              from_line_id: t.from_line_id,
              to_line_id: t.to_line_id,
              walk_time_seconds: Math.round(walk.duration),
              source_id: BAIDU_SOURCE_ID
            });
            if (walk.distance && walk.distance > 0) {
              harvestedWalkM.set(
                `${t.station_id}|${t.from_line_id}|${t.to_line_id}`,
                Math.round(walk.distance)
              );
            }
          }
          break;
        }
      } catch (err) {
        failures.push(
          `transfer ${job.from_station}->${job.to_station}: ${
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
    `  gapfill: +${segTimeFilled} segment times, +${segDistFilled} distances, ` +
      `+${walkFilled} transfer walks (${client.queries} queries, ${failures.length} failures)`
  );
  if (failures.length > 0) {
    console.warn(
      `  gapfill failures (${failures.length}):\n  - ${failures.slice(0, 15).join('\n  - ')}${
        failures.length > 15 ? `\n  … and ${failures.length - 15} more` : ''
      }`
    );
  }
  return {
    segmentTimesFilled: segTimeFilled,
    segmentDistancesFilled: segDistFilled,
    transferWalksFilled: walkFilled,
    queries: client.queries,
    failures
  };
}
