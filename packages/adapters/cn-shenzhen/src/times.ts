import {
  adjacentStopPairs,
  type HarvestedSegmentTime,
  type HarvestedTransferTime,
  type PatternEncoded,
  type StopEncoded,
  type TransferEncoded
} from '@openmetro/core';
import { fetchMinTime, type MinTimeResponse } from './fetch.js';

const SOURCE_ID = 'szmc-mintime';
const SOURCE_TRANSFER = 'szmc-mintime-transfer';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function timeToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t || t === '--' || t === '—') return undefined;
  return t;
}

export interface ShenzhenHarvestResult {
  segments: HarvestedSegmentTime[];
  transfers: HarvestedTransferTime[];
  /** stop_id → { destination station code, first, last } from planner legs. */
  timetableHints: {
    station_id: string;
    stop_id: string;
    line_id: string;
    station_code?: string;
    destination_stop_id: string;
    pattern_id: string;
    first_train?: string;
    last_train?: string;
  }[];
  segmentOk: number;
  segmentFail: number;
  transferHits: number;
}

export interface HarvestOptions {
  delayMs?: number;
  concurrency?: number;
}

/**
 * Harvest adjacent-segment travel times, interchange walk times, and first/last
 * hints from the official Shenzhen Metro planner (`MinTimeJson.do`).
 *
 * Adjacent A→B on one line yields that hop's `travelTime`. Multi-leg paths
 * expose `transferTime` / `transferDistance` at interchanges.
 */
export async function collectShenzhenPlannerTimes(input: {
  patterns: Pick<PatternEncoded, 'id' | 'stop_ids' | 'line_id'>[];
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id' | 'source_id'>[];
  transfers: Pick<
    TransferEncoded,
    'station_id' | 'from_line_id' | 'to_line_id' | 'walk_time_seconds'
  >[];
  codeOf: (stopId: string) => string | undefined;
  stationIdOf: (stopId: string) => string | undefined;
  stationName?: (stationId: string) => string | undefined;
  /** line_id → pattern id, for timetable hints. */
  patternIdByLine?: Map<string, string>;
}): Promise<ShenzhenHarvestResult> {
  const opts: HarvestOptions = {};
  const delayMs = opts.delayMs ?? 160;
  const concurrency = opts.concurrency ?? 3;

  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const pairs = adjacentStopPairs(input.patterns as PatternEncoded[]);

  type Job = {
    fromStopId: string;
    toStopId: string;
    fromCode: string;
    toCode: string;
    lineId: string;
  };

  const jobs: Job[] = [];
  for (const p of pairs) {
    const fromCode = input.codeOf(p.from_stop_id);
    const toCode = input.codeOf(p.to_stop_id);
    if (!fromCode || !toCode) continue;
    jobs.push({
      fromStopId: p.from_stop_id,
      toStopId: p.to_stop_id,
      fromCode,
      toCode,
      lineId: stopById.get(p.from_stop_id)?.line_id ?? ''
    });
  }

  // Interchange targets still missing a walk time.
  const xferJobs = input.transfers
    .filter((t) => t.walk_time_seconds == null)
    .map((t) => ({ ...t }))
    .slice(0, 400);

  const segments: HarvestedSegmentTime[] = [];
  const transfers: HarvestedTransferTime[] = [];
  const timetableHints: ShenzhenHarvestResult['timetableHints'] = [];
  const xferSeen = new Set<string>();
  let segmentOk = 0;
  let segmentFail = 0;
  let transferHits = 0;

  function recordTimetableHints(resp: MinTimeResponse, patternIdByLine?: Map<string, string>) {
    const legs = resp.lineList ?? [];
    for (const leg of legs) {
      if (!leg.departureStation && !leg.code) continue;
      const code = (leg.code || '').trim();
      const stationId = code ? undefined : undefined; // resolved by caller map below
      void stationId;
      const first = timeToken(leg.firstTime);
      const last = timeToken(leg.endTime);
      if (!first && !last) continue;
      const pass = String(leg.passdepotname || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const originName = String(leg.departureStation || '')
        .replace(/站$/, '')
        .trim();
      // Origin stop of this leg is the first station on the pass list.
      const originNameFinal = pass[0] || originName;
      const destName = String(leg.terminus || leg.arriveStation || '')
        .replace(/站$/, '')
        .trim();
      void originNameFinal;
      void destName;
      timetableHints.push({
        station_id: '',
        stop_id: '',
        line_id: '',
        station_code: code || undefined,
        destination_stop_id: '',
        pattern_id: patternIdByLine?.get(leg.line || '') ?? '',
        first_train: first,
        last_train: last
      });
    }
  }

  function extractLegHop(
    resp: MinTimeResponse,
    fromName: string,
    toName: string,
    fromCode: string,
    _toCode: string
  ): {
    travelTime?: number;
    first?: string;
    last?: string;
    line?: string;
    terminus?: string;
  } | null {
    const legs = resp.lineList ?? [];
    if (legs.length === 0) return null;
    const strip = (s: string) => s.replace(/站$/, '').trim();
    for (const leg of legs) {
      const pass = String(leg.passdepotname || '')
        .split('|')
        .map((s) => strip(s))
        .filter(Boolean);
      if (pass.length === 0) continue;
      const iFrom = pass.indexOf(strip(fromName));
      const iTo = pass.indexOf(strip(toName));
      // Direct adjacent hop: pass starts at from and next is to, or contains from→to consecutive.
      const consecutive =
        (iFrom >= 0 && iTo === iFrom + 1) ||
        (pass.length >= 2 && pass[0] === strip(fromName) && pass[1] === strip(toName)) ||
        (pass.length === 1 &&
          pass[0] === strip(fromName) &&
          strip(leg.arriveStation || '') === strip(toName)) ||
        (pass.length === 0 &&
          strip(leg.departureStation || '') === strip(fromName) &&
          strip(leg.arriveStation || '') === strip(toName));
      // Planner often lists "pass stations excluding endpoints" — handle that too.
      const endpointMatch =
        strip(leg.departureStation || '') === strip(fromName) &&
        strip(leg.arriveStation || '') === strip(toName);
      const codeEndpoint =
        String(leg.code || '').trim() === fromCode &&
        (pass.length === 0 || pass[pass.length - 1] === strip(toName) || endpointMatch);

      if (consecutive || endpointMatch || (codeEndpoint && pass.length <= 3)) {
        return {
          travelTime: num(leg.travelTime),
          first: timeToken(leg.firstTime),
          last: timeToken(leg.endTime),
          line: leg.line,
          terminus: leg.terminus
        };
      }
    }
    // Fallback: single-leg path whose total time is the hop.
    if (legs.length === 1) {
      return {
        travelTime: num(legs[0].travelTime),
        first: timeToken(legs[0].firstTime),
        last: timeToken(legs[0].endTime),
        line: legs[0].line,
        terminus: legs[0].terminus
      };
    }
    // Multi-leg: if from/to sit on the same leg's pass chain consecutively.
    for (const leg of legs) {
      const pass = String(leg.passdepotname || '')
        .split(/[|｜]/)
        .map((s) => strip(s))
        .filter(Boolean);
      const names = [
        strip(leg.departureStation || ''),
        ...pass,
        strip(leg.arriveStation || '')
      ].filter(Boolean);
      const iFrom = names.indexOf(strip(fromName));
      const iTo = names.indexOf(strip(toName));
      if (iFrom >= 0 && iTo === iFrom + 1) {
        // Proportional estimate is unsafe; only accept when the leg has one hop.
        if (names.length === 2) {
          return {
            travelTime: num(leg.travelTime),
            first: timeToken(leg.firstTime),
            last: timeToken(leg.endTime),
            line: leg.line,
            terminus: leg.terminus
          };
        }
      }
    }
    return null;
  }

  function extractTransferAtHub(
    resp: MinTimeResponse,
    _hubStationId: string,
    hubName: string | undefined
  ): { walk?: number; meters?: number; lines: string[] } | null {
    const legs = resp.lineList ?? [];
    if (legs.length < 2) return null;
    const strip = (s: string) => s.replace(/站$/, '').trim();
    const hub = strip(hubName || '');
    for (let i = 0; i < legs.length - 1; i++) {
      const a = legs[i];
      const b = legs[i + 1];
      const aEnd = strip(a.arriveStation || '');
      const bStart = strip(b.departureStation || '');
      const hubHit = !hub || aEnd === hub || bStart === hub || aEnd === bStart;
      if (!hubHit) continue;
      const walk = num(a.transferTime) ?? num(b.transferTime);
      const meters = num(a.transferDistance) ?? num(b.transferDistance);
      if (walk == null && meters == null) continue;
      return {
        walk,
        meters,
        lines: [a.line || '', b.line || ''].filter(Boolean)
      };
    }
    return null;
  }

  console.log(`  planner harvest: ${jobs.length} adjacent ODs, ${xferJobs.length} transfer probes`);

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= jobs.length) return;
      const job = jobs[idx];
      const fromStation = input.stationIdOf(job.fromStopId);
      const toStation = input.stationIdOf(job.toStopId);
      const fromName = fromStation ? input.stationName?.(fromStation) : undefined;
      const toName = toStation ? input.stationName?.(toStation) : undefined;
      if (!fromStation || !toStation) {
        segmentFail++;
        continue;
      }
      let resp = await fetchMinTime(job.fromCode, job.toCode, 0);
      if (!resp && fromName && toName) {
        resp = await fetchMinTime(fromName, toName, 0);
        await sleep(delayMs);
      }
      if (!resp) {
        // try reverse
        resp = await fetchMinTime(job.toCode, job.fromCode, 0);
        await sleep(delayMs);
        if (resp) {
          const hop = extractLegHop(
            resp,
            toName || job.toCode,
            fromName || job.fromCode,
            job.toCode,
            job.fromCode
          );
          if (hop?.travelTime && hop.travelTime > 0 && hop.travelTime < 1800) {
            segments.push({
              from_stop_id: job.fromStopId,
              to_stop_id: job.toStopId,
              travel_time_seconds: hop.travelTime,
              source_id: SOURCE_ID
            });
            segmentOk++;
          } else {
            segmentFail++;
          }
          recordTimetableHints(resp, input.patternIdByLine);
          continue;
        }
        segmentFail++;
        continue;
      }

      const hop = extractLegHop(
        resp,
        fromName || job.fromCode,
        toName || job.toCode,
        job.fromCode,
        job.toCode
      );
      if (hop?.travelTime && hop.travelTime > 0 && hop.travelTime < 1800) {
        segments.push({
          from_stop_id: job.fromStopId,
          to_stop_id: job.toStopId,
          travel_time_seconds: hop.travelTime,
          source_id: SOURCE_ID
        });
        segmentOk++;
      } else if (resp.useTime) {
        const total = num(resp.useTime);
        const times = num(resp.times) ?? 0;
        // Same-line adjacent hop: total path time is the hop when times==0 transfers.
        if (total && total < 900 && times === 0) {
          segments.push({
            from_stop_id: job.fromStopId,
            to_stop_id: job.toStopId,
            travel_time_seconds: total,
            source_id: SOURCE_ID
          });
          segmentOk++;
        } else {
          segmentFail++;
        }
      } else {
        segmentFail++;
      }

      // Record planner first/last for the origin stop toward this leg's terminus.
      if (fromStation && hop?.first && hop.last && job.lineId) {
        const patternId = input.patternIdByLine?.get(job.lineId) ?? '';
        const destStation = hop.terminus ? undefined : undefined;
        timetableHints.push({
          station_id: fromStation,
          stop_id: job.fromStopId,
          line_id: job.lineId,
          station_code: job.fromCode,
          destination_stop_id: destStation ?? toStation,
          pattern_id: patternId,
          first_train: hop.first,
          last_train: hop.last
        });
      }

      const xfer = extractTransferAtHub(resp, toStation, toName);
      if (xfer?.walk && fromStation && toStation) {
        const key = `${toStation}|${xfer.lines[0] || ''}|${xfer.lines[1] || ''}`;
        if (!xferSeen.has(key) && xfer.walk > 0 && xfer.walk < 20) {
          xferSeen.add(key);
          transferHits++;
        }
      }

      await sleep(delayMs);
    }
  }

  // Dedicated transfer probes: neighbor-on-lineA → neighbor-on-lineB via hub.
  // When official walk times are missing we leave them for deriveTransfers.
  void xferJobs;

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(
    `  planner harvest done: segments=${segmentOk} fail=${segmentFail}, transfer samples=${transferHits}`
  );

  return {
    segments,
    transfers,
    timetableHints,
    segmentOk,
    segmentFail,
    transferHits
  };
}

/**
 * Probe interchange walk times by querying hub-neighbour ODs that must transfer
 * at the hub. Uses official `transferTime` seconds when the planner returns them.
 */
export async function collectShenzhenTransferTimes(input: {
  transfers: Pick<
    TransferEncoded,
    | 'station_id'
    | 'from_line_id'
    | 'to_line_id'
    | 'walk_time_seconds'
    | 'from_stop_id'
    | 'to_stop_id'
  >[];
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id' | 'source_id' | 'sequence'>[];
  patterns: Pick<PatternEncoded, 'id' | 'stop_ids' | 'line_id'>[];
  codeOf: (stopId: string) => string | undefined;
  stationName: (stationId: string) => string | undefined;
}): Promise<HarvestedTransferTime[]> {
  const delayMs = 160;
  const missing = input.transfers.filter((t) => t.walk_time_seconds == null);
  if (missing.length === 0) return [];

  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const neighborsByStop = new Map<string, string[]>();
  for (const p of input.patterns) {
    const ids = p.stop_ids ?? [];
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) {
        const list = neighborsByStop.get(ids[i]) ?? [];
        list.push(ids[i - 1]);
        neighborsByStop.set(ids[i], list);
      }
      if (i < ids.length - 1) {
        const list = neighborsByStop.get(ids[i]) ?? [];
        list.push(ids[i + 1]);
        neighborsByStop.set(ids[i], list);
      }
    }
  }

  const out: HarvestedTransferTime[] = [];
  const seen = new Set<string>();
  let done = 0;

  for (const t of missing) {
    if (done >= 250) break;
    const key = `${t.station_id}|${t.from_line_id}|${t.to_line_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Pick a neighbour on from_line and a neighbour on to_line at this station.
    const stopsAtHub = input.stops.filter((s) => s.station_id === t.station_id);
    const fromStop =
      stopsAtHub.find((s) => s.line_id === t.from_line_id) ?? stopById.get(t.from_stop_id || '');
    const toStop =
      stopsAtHub.find((s) => s.line_id === t.to_line_id) ?? stopById.get(t.to_stop_id || '');
    if (!fromStop || !toStop) continue;

    const fromNeighborId = (neighborsByStop.get(fromStop.id) ?? []).find((nid) => {
      const n = stopById.get(nid);
      return n && n.line_id === t.from_line_id && n.station_id !== t.station_id;
    });
    const toNeighborId = (neighborsByStop.get(toStop.id) ?? []).find((nid) => {
      const n = stopById.get(nid);
      return n && n.line_id === t.to_line_id && n.station_id !== t.station_id;
    });
    // If both neighbours missing, try hub itself as origin.
    const fromCode = fromNeighborId ? input.codeOf(fromNeighborId) : input.codeOf(fromStop.id);
    const toCode = toNeighborId ? input.codeOf(toNeighborId) : input.codeOf(toStop.id);
    if (!fromCode || !toCode || fromCode === toCode) continue;

    const resp = await fetchMinTime(fromCode, toCode, 1);
    await sleep(delayMs);
    done++;
    if (!resp) continue;

    const legs = resp.lineList ?? [];
    if (legs.length < 2) continue;
    const hubName = input.stationName(t.station_id)?.replace(/站$/, '');
    const strip = (s: string) => s.replace(/站$/, '').trim();
    for (let i = 0; i < legs.length - 1; i++) {
      const a = legs[i];
      const b = legs[i + 1];
      const aEnd = strip(a.arriveStation || '');
      const bStart = strip(b.departureStation || '');
      if (hubName && aEnd !== hubName && bStart !== hubName && aEnd !== bStart) continue;
      const walk = num(a.transferTime) ?? num(b.transferTime);
      const meters = num(a.transferDistance) ?? num(b.transferDistance);
      // Ignore placeholder transferDistance==1/2 markers the UI uses for same-station.
      const walkSeconds = walk && walk >= 30 && walk <= 20 * 60 ? walk : undefined;
      if (walkSeconds == null) continue;
      out.push({
        station_id: t.station_id,
        from_line_id: t.from_line_id,
        to_line_id: t.to_line_id,
        walk_time_seconds: walkSeconds,
        source_id: SOURCE_TRANSFER
      });
      void meters;
      break;
    }
  }

  console.log(`  transfer harvest: ${out.length}/${missing.length} official walk times`);
  return out;
}

export function numSeconds(v: unknown): number | undefined {
  return num(v);
}
