/**
 * Client for the operator's own route/fare planner.
 *
 * `GET https://cms.gyurt.com/external/interface/getSubwayLines?origin=<lat,lng>&destination=<lat,lng>`
 *
 * The endpoint backs the "线路，票价查询" widget on
 * `https://www.gyurt.com/subwayInquiry.html`. One call returns the whole
 * journey:
 *
 * - `data.duration` / `data.distance` / `data.price` — total minutes, metres
 *   and the OD fare in yuan;
 * - `data.list[]` — one entry per leg. A ride leg carries the line name, the
 *   `instructions` sentence (line, direction and stop count), the boarding and
 *   alighting station, the in-vehicle duration and distance, the **boarding
 *   station's first/last train in that direction** and the `stopInfo[]` array
 *   with every passed stop and its coordinate. A transfer leg has an empty
 *   `name` and describes the interchange walk
 *   (`站厅换乘 步行72米`).
 *
 * Two behaviours drive the client design:
 *
 * - **Stations are matched by exact coordinate string.** A coordinate a few
 *   metres off the published one yields `参数有误`, so every query must use
 *   the `index_origin` string of the official station list — never a
 *   geocoded or AMap coordinate.
 * - **The planner is multimodal.** For some pairs it prefers a bus route or a
 *   walk and then reports `price: -1`. Only plans whose ride legs are all
 *   `轨道交通*` are treated as metro journeys.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { GY_CMS, GY_PLANNER_PATH, GY_REFERER } from './fetch.js';
import { guiyangStationName } from './names.js';

export interface PlannerStop {
  /** Station name as the operator spells it in this response. */
  name: string;
  /** Canonical Chinese station name. */
  canonicalName: string;
  lat?: number;
  lng?: number;
}

export interface PlannerLeg {
  /** Line label, e.g. `轨道交通3号线`. Empty for a walk/transfer leg. */
  line: string;
  /** The operator's instruction sentence. */
  instructions: string;
  /** Boarding station, canonical name. */
  onStation?: string;
  /** Alighting station, canonical name. */
  offStation?: string;
  /** In-vehicle duration in minutes (the operator rounds to whole minutes). */
  durationMinutes?: number;
  /** Leg distance in metres. */
  distanceMeters?: number;
  /** First train at the boarding station in this direction. */
  firstTime?: string;
  /** Last train at the boarding station in this direction. */
  lastTime?: string;
  /** Stops passed, per the operator. */
  stopCount?: number;
  /** Passed stops with their coordinates. */
  stops: PlannerStop[];
  lat?: number;
  lng?: number;
  /** True for a walking / interchange leg. */
  isWalk: boolean;
}

export interface PlannerPlan {
  /** Total journey duration in minutes. */
  durationMinutes?: number;
  /** Total journey distance in metres. */
  distanceMeters?: number;
  /** OD fare in yuan; `-1` when the planner quotes no fare. */
  price?: number;
  legs: PlannerLeg[];
  /** True when every ride leg is a metro line (no bus, no walk). */
  metroOnly: boolean;
}

interface RawStopInfo {
  stop_name?: string;
  stop_location?: { lat?: number; lng?: number };
}

interface RawLeg {
  name?: string;
  instructions?: string;
  onStation?: string;
  offStation?: string;
  duration?: string;
  distance?: number;
  firstTime?: string;
  lastTime?: string;
  stopNum?: number;
  stopInfo?: RawStopInfo[];
  startLocation?: { lat?: number; lng?: number };
  endLocation?: { lat?: number; lng?: number };
}

interface RawPlan {
  duration?: string;
  distance?: number;
  price?: number;
  list?: RawLeg[];
}

interface RawResponse {
  code?: number;
  msg?: string;
  data?: RawPlan;
}

/** `"64分钟"` → `64`. */
function parseMinutes(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /(-?\d+)/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Metro line labels the operator uses, e.g. `轨道交通3号线`. */
export function isMetroLineName(line: string | undefined): boolean {
  return typeof line === 'string' && line.includes('轨道交通');
}

/**
 * Parse one planner response.
 *
 * Returns `undefined` when the operator rejects the query (`参数有误`) — the
 * caller decides whether that is fatal.
 */
export function parsePlannerResponse(raw: unknown): PlannerPlan | undefined {
  const body = raw as RawResponse | undefined;
  if (body?.code !== 0 || !body.data) return undefined;

  const legs: PlannerLeg[] = [];
  for (const leg of body.data.list ?? []) {
    const line = (leg.name ?? '').trim();
    const stops: PlannerStop[] = (leg.stopInfo ?? []).map((s) => ({
      name: (s.stop_name ?? '').trim(),
      canonicalName: guiyangStationName(s.stop_name ?? ''),
      lat: s.stop_location?.lat,
      lng: s.stop_location?.lng
    }));
    legs.push({
      line,
      instructions: (leg.instructions ?? '').trim(),
      onStation: leg.onStation ? guiyangStationName(leg.onStation) : undefined,
      offStation: leg.offStation ? guiyangStationName(leg.offStation) : undefined,
      durationMinutes: parseMinutes(leg.duration),
      distanceMeters: typeof leg.distance === 'number' ? leg.distance : undefined,
      firstTime: leg.firstTime?.trim() || undefined,
      lastTime: leg.lastTime?.trim() || undefined,
      stopCount: typeof leg.stopNum === 'number' ? leg.stopNum : undefined,
      stops,
      lat: leg.startLocation?.lat,
      lng: leg.startLocation?.lng,
      isWalk: line.length === 0
    });
  }

  const rideLegs = legs.filter((l) => !l.isWalk);
  const metroOnly =
    legs.length > 0 &&
    rideLegs.length > 0 &&
    rideLegs.every((l) => isMetroLineName(l.line)) &&
    legs.every((l) => l.isWalk || isMetroLineName(l.line));

  return {
    durationMinutes: parseMinutes(body.data.duration),
    distanceMeters: typeof body.data.distance === 'number' ? body.data.distance : undefined,
    price: typeof body.data.price === 'number' ? body.data.price : undefined,
    legs,
    metroOnly
  };
}

/**
 * Direction label the operator prints in `instructions`, e.g. `窦官方向`.
 *
 * The label is the *terminal* the service heads toward, which is what the
 * canonical timetable's `destination_stop_id` models. It may itself contain
 * parentheses — 3 号线 heads toward `桐木岭(省委党校)` — so the line name is
 * matched without parentheses and the direction may contain them.
 */
export function parseDirection(instructions: string | undefined): string | undefined {
  if (!instructions) return undefined;
  const m = /轨道交通[^()（）]*\((.+?)方向\)/.exec(instructions);
  return m?.[1]?.trim() || undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlannerQueryOptions {
  retries?: number;
  delayMs?: number;
}

/**
 * Query the operator's planner.
 *
 * `origin` and `destination` must be the operator's own coordinate strings
 * (`lat,lng`) taken from the official station list.
 */
export async function queryPlanner(
  origin: string,
  destination: string,
  opts: PlannerQueryOptions = {}
): Promise<PlannerPlan | undefined> {
  const retries = opts.retries ?? 3;
  const url =
    `${GY_CMS}${GY_PLANNER_PATH}` +
    `?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: GY_REFERER, Accept: 'application/json' }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`planner ${res.status}`);
      const body = await res.json();
      const plan = parsePlannerResponse(body);
      if (plan) return plan;
      // The operator answered with an application-level error (`参数有误`).
      // Retrying the same pair cannot help, so fail fast.
      const msg = (body as RawResponse)?.msg ?? 'no plan';
      throw new PlannerRejectedError(msg);
    } catch (err) {
      lastErr = err;
      if (err instanceof PlannerRejectedError) throw err;
      const delay = 400 * 2 ** attempt;
      console.log(`  planner retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** The operator rejected the query (unknown coordinates / same station). */
export class PlannerRejectedError extends Error {
  constructor(message: string) {
    super(`planner rejected the query: ${message}`);
    this.name = 'PlannerRejectedError';
  }
}

/**
 * The metro ride legs of a plan (walking/transfer legs excluded).
 */
export function metroLegs(plan: PlannerPlan | undefined): PlannerLeg[] {
  return (plan?.legs ?? []).filter((l) => !l.isWalk && isMetroLineName(l.line));
}

/**
 * The walking/transfer legs of a plan.
 */
export function walkLegs(plan: PlannerPlan | undefined): PlannerLeg[] {
  return (plan?.legs ?? []).filter((l) => l.isWalk);
}
