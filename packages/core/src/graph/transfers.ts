import { haversineKm } from '../geocode/consistency.js';
import type { StationEncoded, StopEncoded, TransferEncoded } from '../schema/index.js';

/**
 * An officially published transfer time (e.g. Beijing's `interchange.xml`).
 * Keyed by station + ordered line pair; anything not covered falls back to the
 * network's `routing.default_transfer_seconds`.
 */
export interface OfficialTransfer {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  walk_time_seconds?: number;
  is_out_of_station?: boolean;
  source_id?: string;
}

function key(stationId: string, fromLineId: string, toLineId: string): string {
  return `${stationId}|${fromLineId}|${toLineId}`;
}

/** Cross-station auto-transfer constants (calibrated; see design notes). */
export const CROSS_XFER = {
  sourcePrefix: 'auto-xfer/v1',
  walkSpeedMps: 1.3,
  oosOverheadSec: 90,
  /** R7 strict accept when distance ≤ this without hub-like names. */
  dStrictM: 120,
  /** R6/R7 max distance. */
  dHubM: 400,
  /** R1–R5 max distance when names already match (covers long OSI concourses). */
  dNameM: 900,
  minDistM: 5,
  defaultWalkSec: 120,
  maxWalkSec: 600
} as const;

export const CROSS_XFER_RULES = {
  NAME_EXACT: 'NAME_EXACT',
  NAME_STA_SUFFIX: 'NAME_STA_SUFFIX',
  NAME_METRO_ACCESS: 'NAME_METRO_ACCESS',
  NAME_AIRPORT: 'NAME_AIRPORT',
  NAME_DIR: 'NAME_DIR',
  NAME_TOKEN: 'NAME_TOKEN',
  HUB_NEAR: 'HUB_NEAR',
  CLUSTER_COMPLETE: 'CLUSTER_COMPLETE'
} as const;

export type CrossXferRule = (typeof CROSS_XFER_RULES)[keyof typeof CROSS_XFER_RULES];

const RULE_PRIORITY: CrossXferRule[] = [
  CROSS_XFER_RULES.NAME_EXACT,
  CROSS_XFER_RULES.NAME_STA_SUFFIX,
  CROSS_XFER_RULES.NAME_METRO_ACCESS,
  CROSS_XFER_RULES.NAME_AIRPORT,
  CROSS_XFER_RULES.NAME_DIR,
  CROSS_XFER_RULES.NAME_TOKEN,
  CROSS_XFER_RULES.HUB_NEAR,
  CROSS_XFER_RULES.CLUSTER_COMPLETE
];

const SYSTEM_INTERCITY = /城际/;
const SYSTEM_TRAM = /有轨|新交通/;
const SYSTEM_AIRPORT_TERM = /航站楼|^T\d+/i;
const DIR_CHARS = new Set(['南', '北', '东', '西']);
const TOKEN_STOPWORDS = new Set([
  '地铁',
  '公园',
  '大道',
  '路口',
  '客运',
  '中心',
  '医院',
  '学校',
  '广场',
  '市场',
  '车站',
  '枢纽'
]);
const HUB_LIKE = /站|铁路|机场|枢纽/;

export interface StationNameMeta {
  id: string;
  zh: string;
  exact: string;
  tags: Set<string>;
  hasZhan: boolean;
  metroAccess: boolean;
  dir?: string;
  baseNoDir: string;
  airportKey?: string;
  tokens: string[];
  bareNoZhan?: string;
}

function cjkTokens(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) {
    const t = s.slice(i, i + 2);
    if (!TOKEN_STOPWORDS.has(t)) out.push(t);
  }
  if (s.length >= 3 && !TOKEN_STOPWORDS.has(s.slice(-2))) out.push(s.slice(-2));
  return [...new Set(out)];
}

/** Deterministic Chinese station-name normalization for cross-station xfer rules. */
export function normalizeStationName(id: string, zh: string): StationNameMeta {
  const tags = new Set<string>();
  let s = (zh ?? '').trim();
  let parenInner = '';
  while (/[(（][^)）]*[)）]\s*$/.test(s)) {
    const m = s.match(/[(（]([^)）]*)[)）]\s*$/);
    if (!m) break;
    parenInner = m[1].trim();
    s = s.slice(0, m.index).trim();
    if (SYSTEM_INTERCITY.test(parenInner)) tags.add('system=intercity');
    else if (SYSTEM_TRAM.test(parenInner)) tags.add('system=tram');
    else if (SYSTEM_AIRPORT_TERM.test(parenInner)) tags.add('system=airport_terminal');
    else if (/原/.test(parenInner)) tags.add('alias=former');
    else if (/号线|^L\d+/i.test(parenInner)) tags.add('system=line_disambiguator');
  }
  let metroAccess = false;
  if (s.startsWith('地铁') && s.length > 2) {
    metroAccess = true;
    tags.add('access_metro');
    s = s.slice(2);
  }
  let hasZhan = false;
  let bareNoZhan: string | undefined;
  if (s.endsWith('站') && s.length > 1) {
    hasZhan = true;
    tags.add('has_zhan');
    bareNoZhan = s.slice(0, -1);
  }
  let dir: string | undefined;
  let baseNoDir = s;
  if (s.length >= 3) {
    const last = s[s.length - 1];
    if (DIR_CHARS.has(last)) {
      dir = last;
      baseNoDir = s.slice(0, -1);
      tags.add(`dir=${dir}`);
    }
  }
  let airportKey: string | undefined;
  if (/机场/.test(s)) {
    airportKey = s.replace(/^(?:白云|深圳|广州|佛山)/, '');
    tags.add('airport');
  }
  const exact = s;
  return {
    id,
    zh,
    exact,
    tags,
    hasZhan,
    metroAccess,
    dir,
    baseNoDir,
    airportKey,
    tokens: cjkTokens(s),
    bareNoZhan
  };
}

function modesOfStation(
  stationId: string,
  stopsByStation: Map<string, string[]>,
  modeByLine: Map<string, string>
): Set<string> {
  const out = new Set<string>();
  for (const lineId of stopsByStation.get(stationId) ?? []) {
    const m = modeByLine.get(lineId);
    if (m) out.add(m);
  }
  return out;
}

function modesDisjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

function isCrossSystemTag(a: StationNameMeta, b: StationNameMeta): boolean {
  const sysOf = (m: StationNameMeta) => {
    if (m.tags.has('system=intercity')) return 'intercity';
    if (m.tags.has('system=tram')) return 'tram';
    if (m.tags.has('system=airport_terminal')) return 'airport_terminal';
    return 'default';
  };
  const sa = sysOf(a);
  const sb = sysOf(b);
  if (sa !== sb && sa !== 'default' && sb !== 'default') return true;
  if ((sa === 'intercity' || sa === 'tram' || sa === 'airport_terminal') && sb === 'default')
    return true;
  if ((sb === 'intercity' || sb === 'tram' || sb === 'airport_terminal') && sa === 'default')
    return true;
  return false;
}

function hubLike(m: StationNameMeta, lineCount: number): boolean {
  return HUB_LIKE.test(m.zh) || lineCount >= 2;
}

function nameRelatedRules(a: StationNameMeta, b: StationNameMeta): CrossXferRule[] {
  const rules: CrossXferRule[] = [];
  if (a.exact && a.exact === b.exact) {
    rules.push(CROSS_XFER_RULES.NAME_EXACT);
  }
  const namesA = new Set([a.exact, a.bareNoZhan].filter(Boolean) as string[]);
  const namesB = new Set([b.exact, b.bareNoZhan].filter(Boolean) as string[]);
  if ([...namesA].some((x) => namesB.has(x)) && (a.hasZhan || b.hasZhan)) {
    rules.push(CROSS_XFER_RULES.NAME_STA_SUFFIX);
  }
  if ((a.metroAccess && a.exact === b.exact) || (b.metroAccess && b.exact === a.exact)) {
    rules.push(CROSS_XFER_RULES.NAME_METRO_ACCESS);
  }
  if (a.airportKey && b.airportKey && a.airportKey === b.airportKey) {
    const termA = a.tags.has('system=airport_terminal');
    const termB = b.tags.has('system=airport_terminal');
    if (termA === termB || !termA || !termB) rules.push(CROSS_XFER_RULES.NAME_AIRPORT);
  }
  if (a.baseNoDir && a.baseNoDir === b.baseNoDir && a.exact !== b.exact) {
    rules.push(CROSS_XFER_RULES.NAME_DIR);
  }
  const shared = a.tokens.filter((t) => b.tokens.includes(t));
  if (shared.length > 0) rules.push(CROSS_XFER_RULES.NAME_TOKEN);
  return rules;
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function walkSeconds(distM: number, defaultSec: number, maxSec: number): number {
  const raw = Math.round(distM / CROSS_XFER.walkSpeedMps) + CROSS_XFER.oosOverheadSec;
  return Math.max(defaultSec, Math.min(maxSec, raw));
}

export interface CrossStationInput {
  stations: Pick<StationEncoded, 'id' | 'name' | 'names' | 'location' | 'status'>[];
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id'>[];
  patterns?: { id: string; stop_ids?: readonly string[] }[];
  lines?: { id: string; mode?: string }[];
  routing?: { default_transfer_seconds?: number; max_transfer_seconds?: number };
}

/**
 * Derive cross-station (out-of-station) transfer edges from names + geometry
 * + line topology only. Fully automatic; `source_id` is rule-based.
 */
export function deriveCrossStationTransfers(input: CrossStationInput): TransferEncoded[] {
  const { stations, stops, patterns = [], lines = [], routing } = input;
  const defaultWalk = routing?.default_transfer_seconds ?? CROSS_XFER.defaultWalkSec;
  const maxWalk = routing?.max_transfer_seconds ?? CROSS_XFER.maxWalkSec;

  const stationIds = new Set(stations.map((s) => s.id));
  const stopByStation = new Map<string, Map<string, string>>();
  const stopsByStation = new Map<string, string[]>();
  const modeByLine = new Map(lines.map((l) => [l.id, l.mode ?? 'other']));
  const stopToStation = new Map<string, string>();
  const stopToLine = new Map<string, string>();

  for (const stop of stops) {
    if (!stationIds.has(stop.station_id)) continue;
    stopToStation.set(stop.id, stop.station_id);
    stopToLine.set(stop.id, stop.line_id);
    const byLine = stopByStation.get(stop.station_id) ?? new Map<string, string>();
    if (!byLine.has(stop.line_id)) byLine.set(stop.line_id, stop.id);
    stopByStation.set(stop.station_id, byLine);
    const list = stopsByStation.get(stop.station_id) ?? [];
    if (!list.includes(stop.line_id)) list.push(stop.line_id);
    stopsByStation.set(stop.station_id, list);
  }

  const adjacentStops = new Set<string>();
  for (const p of patterns) {
    const seq = p.stop_ids ?? [];
    for (let i = 0; i + 1 < seq.length; i++) {
      adjacentStops.add(pairKey(seq[i], seq[i + 1]).join('|'));
    }
  }

  const meta = new Map<string, StationNameMeta>();
  const locOf = new Map<string, { lon: number; lat: number }>();
  for (const st of stations) {
    const zh = st.names?.zh ?? st.name ?? '';
    meta.set(st.id, normalizeStationName(st.id, zh));
    if (st.location) locOf.set(st.id, { lon: st.location.lon, lat: st.location.lat });
  }

  const locatable = stations.filter(
    (s) => locOf.has(s.id) && (stopsByStation.get(s.id)?.length ?? 0) > 0
  );

  const isConsecutive = (a: string, b: string): boolean => {
    const linesA = stopsByStation.get(a) ?? [];
    const linesB = stopsByStation.get(b) ?? [];
    for (const la of linesA) {
      for (const lb of linesB) {
        if (la !== lb) continue;
        const stopsA = [...(stopByStation.get(a)?.get(la) ? [stopByStation.get(a)!.get(la)!] : [])];
        const stopsB = [...(stopByStation.get(b)?.get(lb) ? [stopByStation.get(b)!.get(lb)!] : [])];
        for (const sa of stopsA) {
          for (const sb of stopsB) {
            if (adjacentStops.has(pairKey(sa, sb).join('|'))) return true;
          }
        }
      }
    }
    return false;
  };

  const modesCache = new Map<string, Set<string>>();
  const modesOf = (id: string) => {
    let m = modesCache.get(id);
    if (!m) {
      m = modesOfStation(id, stopsByStation, modeByLine);
      modesCache.set(id, m);
    }
    return m;
  };

  const lineCount = (id: string) => (stopsByStation.get(id) ?? []).length;

  const veto = (a: string, b: string, distM: number, fireName: boolean): boolean => {
    if (a === b) return true;
    if (distM < CROSS_XFER.minDistM) return true;
    if (!fireName && distM > CROSS_XFER.dHubM) return true;
    if (fireName && distM > CROSS_XFER.dNameM) return true;
    if (isConsecutive(a, b)) return true;
    return false;
  };

  const accepted = new Map<
    string,
    { a: string; b: string; rules: Set<CrossXferRule>; distM: number }
  >();

  const consider = (aId: string, bId: string) => {
    const ma = meta.get(aId)!;
    const mb = meta.get(bId)!;
    const la = locOf.get(aId)!;
    const lb = locOf.get(bId)!;
    const distM = haversineKm(la, lb) * 1000;
    const nameRules = nameRelatedRules(ma, mb);
    const nameHit =
      nameRules.length > 0 &&
      nameRules.some(
        (r) =>
          r === CROSS_XFER_RULES.NAME_EXACT ||
          r === CROSS_XFER_RULES.NAME_STA_SUFFIX ||
          r === CROSS_XFER_RULES.NAME_METRO_ACCESS ||
          r === CROSS_XFER_RULES.NAME_AIRPORT ||
          r === CROSS_XFER_RULES.NAME_DIR
      );
    const tokenHit = nameRules.includes(CROSS_XFER_RULES.NAME_TOKEN);
    const modesA = modesOf(aId);
    const modesB = modesOf(bId);
    const crossTag = isCrossSystemTag(ma, mb);
    const disj = modesDisjoint(modesA, modesB);

    const rules = new Set<CrossXferRule>();

    if (nameHit && !veto(aId, bId, distM, true) && (disj || crossTag || modesA.size === 0)) {
      // Name-exact families may be same-mode (rare); still allow when tags differ.
      if (disj || crossTag || ma.exact === mb.exact) {
        for (const r of nameRules) {
          if (r !== CROSS_XFER_RULES.NAME_TOKEN) rules.add(r);
        }
      }
    }

    if (
      tokenHit &&
      distM <= CROSS_XFER.dHubM &&
      (disj || crossTag) &&
      !veto(aId, bId, distM, true)
    ) {
      rules.add(CROSS_XFER_RULES.NAME_TOKEN);
    }

    // R7 HUB_NEAR strict
    if (
      distM <= CROSS_XFER.dHubM &&
      (disj || crossTag) &&
      !veto(aId, bId, distM, false) &&
      (distM <= CROSS_XFER.dStrictM ||
        hubLike(ma, lineCount(aId)) ||
        hubLike(mb, lineCount(bId)) ||
        (Math.min(lineCount(aId), lineCount(bId)) >= 2 && disj))
    ) {
      rules.add(CROSS_XFER_RULES.HUB_NEAR);
    }

    if (rules.size === 0) return;
    const [ka, kb] = pairKey(aId, bId);
    const prev = accepted.get(`${ka}|${kb}`);
    if (prev) {
      for (const r of rules) prev.rules.add(r);
    } else {
      accepted.set(`${ka}|${kb}`, { a: ka, b: kb, rules, distM });
    }
  };

  for (let i = 0; i < locatable.length; i++) {
    for (let j = i + 1; j < locatable.length; j++) {
      consider(locatable[i].id, locatable[j].id);
    }
  }

  // R8 CLUSTER_COMPLETE: union-find on accepted name/hub edges, then fill mode-disjoint pairs in components
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const e of accepted.values()) union(e.a, e.b);
  const comps = new Map<string, string[]>();
  for (const st of locatable) {
    if (!parent.has(st.id)) continue;
    const r = find(st.id);
    const list = comps.get(r) ?? [];
    list.push(st.id);
    comps.set(r, list);
  }
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    const modeSets = members.map((id) => modesOf(id));
    const allModes = new Set(modeSets.flatMap((s) => [...s]));
    if (allModes.size < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const [ka, kb] = pairKey(a, b);
        const k = `${ka}|${kb}`;
        if (accepted.has(k)) continue;
        if (!modesDisjoint(modesOf(a), modesOf(b))) continue;
        const la = locOf.get(a)!;
        const lb = locOf.get(b)!;
        const distM = haversineKm(la, lb) * 1000;
        if (distM > CROSS_XFER.dHubM) continue;
        if (isConsecutive(a, b)) continue;
        accepted.set(k, {
          a: ka,
          b: kb,
          rules: new Set([CROSS_XFER_RULES.CLUSTER_COMPLETE]),
          distM
        });
      }
    }
  }

  const out: TransferEncoded[] = [];
  for (const e of accepted.values()) {
    const primary = RULE_PRIORITY.find((r) => e.rules.has(r)) ?? CROSS_XFER_RULES.HUB_NEAR;
    const [idA, idB] = [e.a, e.b];
    const walk = walkSeconds(e.distM, defaultWalk, maxWalk);
    const linesA = [...(stopsByStation.get(idA) ?? [])].sort();
    const linesB = [...(stopsByStation.get(idB) ?? [])].sort();
    const stopsA = stopByStation.get(idA) ?? new Map();
    const stopsB = stopByStation.get(idB) ?? new Map();
    const rulesFired = RULE_PRIORITY.filter((r) => e.rules.has(r));
    const sourceBase = `${CROSS_XFER.sourcePrefix}/${primary}/${idA}__${idB}`;

    const emit = (
      fromStation: string,
      _toStation: string,
      fromLine: string,
      toLine: string,
      fromStop: string,
      toStop: string
    ) => {
      out.push({
        id: `xfer-${fromStop}-${toStop}`,
        station_id: fromStation,
        from_line_id: fromLine,
        to_line_id: toLine,
        from_stop_id: fromStop,
        to_stop_id: toStop,
        walk_time_seconds: walk,
        walk_distance_meters: Math.round(e.distM),
        is_out_of_station: true,
        source_id: sourceBase,
        extras: {
          rule: primary,
          rules_fired: rulesFired,
          dist_m: Math.round(e.distM),
          walk_model: 'auto-v1'
        }
      });
    };

    for (const la of linesA) {
      for (const lb of linesB) {
        const sa = stopsA.get(la);
        const sb = stopsB.get(lb);
        if (!sa || !sb) continue;
        emit(idA, idB, la, lb, sa, sb);
        emit(idB, idA, lb, la, sb, sa);
      }
    }
  }

  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Derive the canonical transfer edge set for a network.
 *
 * Same-station line-to-line transfers first (official walk times when present),
 * then automatic cross-station out-of-station edges from names + geometry.
 */
export function deriveTransfers(
  stations: Pick<StationEncoded, 'id'>[],
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id'>[],
  official: OfficialTransfer[] = [],
  opts?: {
    patterns?: { id: string; stop_ids?: readonly string[] }[];
    lines?: { id: string; mode?: string }[];
    routing?: { default_transfer_seconds?: number; max_transfer_seconds?: number };
    /** When false, skip automatic cross-station edges. Default true. */
    crossStation?: boolean;
  }
): TransferEncoded[] {
  const stationIds = new Set(stations.map((s) => s.id));
  const linesByStation = new Map<string, Map<string, string>>();
  for (const stop of stops) {
    if (!stationIds.has(stop.station_id)) continue;
    const lines = linesByStation.get(stop.station_id) ?? new Map<string, string>();
    if (!lines.has(stop.line_id)) lines.set(stop.line_id, stop.id);
    linesByStation.set(stop.station_id, lines);
  }

  const officialByKey = new Map<string, OfficialTransfer>();
  for (const o of official) {
    officialByKey.set(key(o.station_id, o.from_line_id, o.to_line_id), o);
  }

  const out: TransferEncoded[] = [];
  for (const [stationId, lines] of linesByStation) {
    const entries = [...lines.entries()];
    if (entries.length < 2) continue;
    for (const [fromLineId, fromStopId] of entries) {
      for (const [toLineId, toStopId] of entries) {
        if (fromLineId === toLineId) continue;
        const match = officialByKey.get(key(stationId, fromLineId, toLineId));
        out.push({
          id: `xfer-${fromStopId}-${toStopId}`,
          station_id: stationId,
          from_line_id: fromLineId,
          to_line_id: toLineId,
          from_stop_id: fromStopId,
          to_stop_id: toStopId,
          walk_time_seconds: match?.walk_time_seconds,
          is_out_of_station: match?.is_out_of_station,
          source_id: match?.source_id
        });
      }
    }
  }

  if (opts?.crossStation !== false) {
    const fullStations = stations as Pick<
      StationEncoded,
      'id' | 'name' | 'names' | 'location' | 'status'
    >[];
    const hasLoc = fullStations.some((s) => s.location && (s.names?.zh || s.name));
    if (hasLoc && (opts?.patterns || opts?.lines)) {
      const cross = deriveCrossStationTransfers({
        stations: fullStations,
        stops,
        patterns: opts?.patterns,
        lines: opts?.lines,
        routing: opts?.routing
      });
      const seen = new Set(out.map((t) => t.id));
      for (const t of cross) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
      }
    }
  }

  return out;
}
