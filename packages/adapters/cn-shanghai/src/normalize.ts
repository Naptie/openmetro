import {
  applyDerivedTimes,
  applyTimetableServiceStatus,
  bd09ToGcj02,
  deriveSegmentTimes,
  deriveTransfers,
  hasValidTimes,
  type LineEncoded,
  type NetworkEncoded,
  normalizeTimetableTimes,
  type PatternEncoded,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import type { FlTimeRow } from './viewlnfltime.js';

export interface ShRawInput {
  lineSequences: Record<string, { code: string; name: string }[]>;
  lines: Record<string, { line_no: number; description: string; desc_en: string; color: string }>;
  stations: Record<string, ShStationInfo[]>;
  /** line_no -> official per-line first/last timetable rows (sole source). */
  fltimeRows: Record<string, FlTimeRow[]>;
  /** line_no -> human-readable branch note parsed from the timetable page. */
  lineNotes?: Record<string, string | undefined>;
  /** Chinese title → every distinct official map code for that title. */
  nameToCodes: Record<string, string[]>;
}

export interface ShStationInfo {
  stat_id: string;
  name_cn: string;
  name_en: string;
  pinyin: string;
  station_code: string;
  lines: string;
  longitude: number;
  latitude: number;
  gao_lng?: number;
  gao_lat?: number;
  x: number;
  y: number;
}

export interface ShCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /**
   * Official stationInfo coords as GCJ-02, keyed by **station id** (not
   * Chinese name). Same-name platforms that are not one physical station
   * (e.g. 浦东南路 Line 2 vs Line 14) each need their own coordinate;
   * name-keyed lookup would put both stops on one platform.
   * Prefers `gao_lng`/`gao_lat` (already GCJ-02); falls back to converting
   * the BD-09 `longitude`/`latitude` pair.
   */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

const NETWORK_ID = 'cn-shanghai';
const DEFAULT_SEGMENT_SECONDS = 120;

/**
 * Same public Chinese name, distinct official map codes, NOT a passenger
 * transfer. Line 2's 浦东南路 (formerly 东昌路) and Line 14's 浦东南路 sit
 * ~680 m apart with no connecting passage; merging them invents a fake
 * interchange and bends Line 14 geometry toward the Line 2 platform.
 *
 * Other multi-code names in Shanghai (国家会展中心, 虹桥2号航站楼,
 * 浦东1号2号航站楼) are real distant transfers and stay merged.
 */
const SAME_NAME_SEPARATE = new Set(['浦东南路']);

const isUsable = (v: number | undefined): v is number => Number.isFinite(v) && v !== 0;

/**
 * Official stationInfo GCJ-02 coordinate.
 *
 * `gao_lng`/`gao_lat` are already GCJ-02 (verified against the AMap subway
 * dataset, p50 ≈ 30 m). `longitude`/`latitude` are BD-09 and must be converted.
 */
function officialGcj02(
  info: ShStationInfo
): { lon: number; lat: number; crs: 'gcj02' } | undefined {
  if (isUsable(info.gao_lng) && isUsable(info.gao_lat)) {
    return { lon: info.gao_lng, lat: info.gao_lat, crs: 'gcj02' };
  }
  if (isUsable(info.longitude) && isUsable(info.latitude)) {
    return bd09ToGcj02(info.longitude, info.latitude);
  }
  return undefined;
}

function slug(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!out) {
    out = [...Buffer.from(s, 'utf-8')].map((b) => b.toString(16)).join('');
  }
  return out;
}

/**
 * Parse the Shanghai `last_time_desc` JSON string to build the per-weekday
 * last-train array. `last_time_desc` is `{"weekday":[0,0,0,0,0,88,88],
 * "dateday":[...]}` where the weekday array holds minute additions for each day
 * (0=Mon..6=Sun), and non-zero indicates an extended last train. The base
 * `last_time` is the weekday-common time; add the weekday delta to build a
 * 7-element array. Returns a 7-element array when any weekday differs, else a
 * single-element array.
 */
export function buildLastTrainArray(baseLast: string, lastTimeDesc: string | undefined): string[] {
  if (!lastTimeDesc) return [baseLast];
  let parsed: { weekday?: number[] };
  try {
    parsed = JSON.parse(lastTimeDesc);
  } catch {
    return [baseLast];
  }
  const wd = parsed.weekday;
  if (wd?.length !== 7) return [baseLast];
  const hasVariation = wd.some((v) => v !== 0);
  if (!hasVariation) return [baseLast];
  const [h, m] = baseLast.split(':').map(Number);
  const base = h * 60 + m;
  const arr = wd.map((delta) => {
    const total = base + (delta || 0);
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  });
  return arr;
}

/** Decode the data-adjust URL-encoded JSON into a string (for buildLastTrainArray). */
function decodeAdjust(encoded: string | undefined): string | undefined {
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * Build a readable, unique timetable id from a station code, destination, and
 * direction label. The label is slugged when ASCII; otherwise the destination
 * station id + a numeric index is used, so ids never fall back to hex jibberish.
 */
function makeUniqueTimetableId(
  used: Set<string>,
  networkId: string,
  code: string,
  destination: string,
  description?: string
): string {
  const label = description?.trim() ?? '';
  const labelSlug = readableSlug(label) || 'dest';
  const base = `${networkId}-${code}-to-${destination}-${labelSlug}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  used.add(id);
  return id;
}

/** Branch note parsed into main endpoints and branch endpoints. */
interface BranchNote {
  main: [string, string];
  branch: [string, string];
}

/** Match the four station names of the branch note against the flat list. */
function parseBranchNote(note: string | undefined, flatNames: string[]): BranchNote | null {
  if (!note?.includes('支线段')) return null;
  const found: { name: string; index: number }[] = [];
  for (const name of flatNames) {
    const index = note.indexOf(name);
    if (index >= 0) found.push({ name, index });
  }
  found.sort((a, b) => a.index - b.index);
  const names: string[] = [];
  for (const f of found) if (!names.includes(f.name)) names.push(f.name);
  if (names.length < 4) return null;
  return { main: [names[0], names[1]], branch: [names[2], names[3]] };
}

interface XY {
  x: number;
  y: number;
}

/** Distance from point p to the segment a-b. */
function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const c1 = vx * wx + vy * wy;
  const c2 = vx * vx + vy * vy;
  const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, c1 / c2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * Reconstruct a line's route patterns from its flat source sequence and the
 * timetable page's branch note. The flat sequence splices a branch run into the
 * main line at its junction; this walks from the branch terminus toward the
 * junction (stopping at the first main endpoint) to isolate the branch, then
 * derives the through-service branch pattern (branch run + main line from the
 * junction to the far side).
 */
function reconstructPatterns(
  lineId: string,
  lineNo: string,
  flatNames: string[],
  note: string | undefined,
  stopIdByName: Map<string, string>,
  getXY: (name: string) => XY | undefined
): PatternEncoded[] {
  const stopsFor = (names: string[]): string[] =>
    names.map((n) => stopIdByName.get(n)).filter((id): id is string => id !== undefined);

  const single = (): PatternEncoded[] => {
    const stopIds = stopsFor(flatNames);
    return [
      {
        id: `${lineId}-pattern-main`,
        line_id: lineId,
        name: '主线',
        names: { zh: '主线', en: 'Main' },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0],
        terminal_stop_id: stopIds[stopIds.length - 1],
        is_primary: true,
        source_ids: [{ source: 'shmetro-slsddl', id: lineNo }]
      }
    ];
  };

  const parsed = parseBranchNote(note, flatNames);
  if (!parsed) return single();

  const { main, branch } = parsed;
  const [P, Q] = branch;
  const axisA = getXY(main[0]);
  const axisB = getXY(main[1]);
  const pXY = getXY(P);
  const qXY = getXY(Q);
  if (!axisA || !axisB || !pXY || !qXY) return single();

  // The junction lies on the main axis; the branch terminus is off to one side.
  const pDist = pointSegmentDistance(pXY, axisA, axisB);
  const qDist = pointSegmentDistance(qXY, axisA, axisB);
  const junction = pDist <= qDist ? P : Q;
  const terminus = pDist <= qDist ? Q : P;

  const ci = flatNames.indexOf(terminus);
  const ji = flatNames.indexOf(junction);
  if (ci < 0 || ji < 0) return single();

  // Walk from the branch terminus toward the junction, stopping before the
  // junction or the first main endpoint (which marks the trunk).
  const dir = ji > ci ? 1 : -1;
  const run: string[] = [];
  for (let i = ci; i !== ji; i += dir) {
    const name = flatNames[i];
    if (name === main[0] || name === main[1]) break;
    run.push(name);
  }
  if (run.length === 0) return single();

  const runSet = new Set(run);
  const mainNames = flatNames.filter((n) => !runSet.has(n));
  const mainStopIds = stopsFor(mainNames);
  if (mainStopIds.length < 2) return single();

  const patterns: PatternEncoded[] = [
    {
      id: `${lineId}-pattern-main`,
      line_id: lineId,
      name: '主线',
      names: { zh: '主线', en: 'Main' },
      stop_ids: mainStopIds,
      origin_stop_id: mainStopIds[0],
      terminal_stop_id: mainStopIds[mainStopIds.length - 1],
      is_primary: true,
      source_ids: [{ source: 'shmetro-slsddl', id: lineNo }]
    }
  ];

  const junctionId = stopIdByName.get(junction);
  if (junctionId) {
    const jMain = mainNames.indexOf(junction);
    const farSide = ci < ji ? mainNames.slice(jMain) : [...mainNames.slice(0, jMain + 1)].reverse();
    const branchStopIds = stopsFor([...run, ...farSide]);
    if (branchStopIds.length >= 2) {
      patterns.push({
        id: `${lineId}-pattern-branch-${slug(terminus)}`,
        line_id: lineId,
        name: `${terminus}支线`,
        names: { zh: `${terminus}支线`, en: `${terminus} branch` },
        stop_ids: branchStopIds,
        origin_stop_id: branchStopIds[0],
        terminal_stop_id: branchStopIds[branchStopIds.length - 1],
        is_primary: false,
        junction_stop_id: junctionId,
        source_ids: [{ source: 'shmetro-slsddl', id: lineNo }],
        extras: { branch_note: note }
      });
    }
  }

  return patterns;
}

/** Parse a source direction label into origin/destination names. */
function parseDirectionLabel(label: string): { dest?: string; origin?: string } {
  const l = label.trim();
  let m = /^往(.+)$/.exec(l);
  if (m) return { dest: m[1].trim() };
  m = /^(.+?)往(.+)$/.exec(l);
  if (m) return { origin: m[1].trim(), dest: m[2].trim() };
  m = /^(.+?)始发$/.exec(l);
  if (m) return { origin: m[1].trim() };
  return {};
}

/** Detect loop direction type from a Shanghai direction label. */
function detectLoopDirection(label: string): 'loop_inner' | 'loop_outer' | undefined {
  if (label.includes('（内）') || label.includes('(内)')) return 'loop_inner';
  if (label.includes('（外）') || label.includes('(外)')) return 'loop_outer';
  return undefined;
}

/** Check if a line has any loop directions based on its timetable rows. */
function hasLoopDirections(rows: FlTimeRow[]): boolean {
  return rows.some((r) => detectLoopDirection(r.directionLabel) !== undefined);
}

export function normalize(input: ShRawInput): ShCanonical {
  const lineRecords: LineEncoded[] = [];
  const stationMap = new Map<string, StationEncoded>();
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segmentByPair = new Map<string, SegmentEncoded>();

  // station_code -> canonical station id (from station info).
  const codeToStationId = new Map<string, string>();
  /** `name` or `name|lineNo` → schematic XY (split stations need per-line). */
  const xyByName = new Map<string, XY>();
  // Official stationInfo coords keyed by station id (see ShCanonical).
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  /** Chinese name → station id for every physical station under that name. */
  const stationIdsByName = new Map<string, string[]>();
  /** `name|lineNo` → station id (authoritative for stop assignment). */
  const stationIdByNameLine = new Map<string, string>();
  /** Names that were split into multiple physical stations. */
  const splitNames = new Set<string>();

  type Cluster = {
    name: string;
    nameEn: string;
    codes: Set<string>;
    infos: ShStationInfo[];
  };

  const clustersByName = new Map<string, Cluster[]>();
  for (const infos of Object.values(input.stations)) {
    for (const info of infos) {
      const name = info.name_cn.trim();
      if (!name) continue;
      const list = clustersByName.get(name) ?? [];
      const existing = list.find((c) => c.codes.has(info.station_code));
      if (existing) {
        existing.infos.push(info);
      } else {
        list.push({
          name,
          nameEn: info.name_en,
          codes: new Set([info.station_code]),
          infos: [info]
        });
      }
      clustersByName.set(name, list);
    }
  }

  for (const [name, rawClusters] of clustersByName) {
    // One map code = one physical station. Multiple codes stay merged unless
    // the name is a known same-name non-transfer (see SAME_NAME_SEPARATE).
    const clusters =
      rawClusters.length > 1 && SAME_NAME_SEPARATE.has(name)
        ? rawClusters
        : [
            {
              name,
              nameEn: rawClusters[0]?.nameEn ?? name,
              codes: new Set(rawClusters.flatMap((c) => [...c.codes])),
              infos: rawClusters.flatMap((c) => c.infos)
            }
          ];
    if (clusters.length > 1) splitNames.add(name);

    // Lowest line number keeps the unsuffixed id so existing stop ids
    // (`…-2`, `…-14`) and consumer references stay stable for the primary.
    const ordered = [...clusters].sort((a, b) => {
      const la = Math.min(...a.infos.map((i) => Number(i.lines.split(',')[0]) || 99));
      const lb = Math.min(...b.infos.map((i) => Number(i.lines.split(',')[0]) || 99));
      return la - lb || a.infos[0].station_code.localeCompare(b.infos[0].station_code);
    });

    const ids: string[] = [];
    ordered.forEach((cluster, idx) => {
      const sample = cluster.infos[0];
      // Official name_en sometimes carries a trailing space (e.g. Line 2 NECC).
      const nameEn = (sample.name_en || name).trim();
      const base = slug(nameEn || name);
      const lowestLine = [...cluster.infos]
        .flatMap((i) =>
          i.lines
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
        .sort((a, b) => Number(a) - Number(b))[0];
      const id =
        clusters.length === 1
          ? `${NETWORK_ID}-${base}`
          : idx === 0
            ? `${NETWORK_ID}-${base}`
            : `${NETWORK_ID}-${base}-${lowestLine}`;
      ids.push(id);

      const sourceIds = [...cluster.codes].map((code) => ({
        source: 'shmetro-stationInfo',
        id: code
      }));
      stationMap.set(id, {
        id,
        name,
        names: { zh: name, en: nameEn },
        status: 'operating',
        source_ids: sourceIds,
        ...(clusters.length > 1
          ? { extras: { same_name_split: true, map_codes: [...cluster.codes] } }
          : {})
      });

      const loc = officialGcj02(sample);
      if (loc) officialLocations.set(id, loc);

      if (Number.isFinite(sample.x) && Number.isFinite(sample.y)) {
        const xy = { x: sample.x, y: sample.y };
        if (clusters.length > 1) {
          for (const info of cluster.infos) {
            for (const ln of info.lines
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)) {
              xyByName.set(`${name}|${ln}`, xy);
            }
          }
        } else if (!xyByName.has(name)) {
          xyByName.set(name, xy);
        }
      }

      for (const code of cluster.codes) codeToStationId.set(code, id);
      for (const info of cluster.infos) {
        for (const ln of info.lines
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          stationIdByNameLine.set(`${name}|${ln}`, id);
        }
      }
    });
    stationIdsByName.set(name, ids);
  }

  const resolveStation = (name: string, lineNo: string): StationEncoded | undefined => {
    const id = stationIdByNameLine.get(`${name}|${lineNo}`) ?? stationIdsByName.get(name)?.[0];
    return id ? stationMap.get(id) : undefined;
  };

  // Detect loop lines from timetable direction labels.
  const loopLines = new Set<string>();
  for (const [lineNo, rows] of Object.entries(input.fltimeRows)) {
    if (hasLoopDirections(rows)) {
      loopLines.add(lineNo);
    }
  }

  for (const [lineNo, meta] of Object.entries(input.lines)) {
    const lineId = `${NETWORK_ID}-line-${lineNo}`;
    // Chinese names come from the official timetable page; English is derived
    // (Wikidata upgrades it later), matching the Beijing adapter's pipeline.
    lineRecords.push({
      id: lineId,
      name: meta.description,
      names: { zh: meta.description, en: meta.desc_en },
      aliases: [],
      mode: lineNo === '41' || lineNo === '51' ? 'suburban_rail' : 'metro',
      status: 'operating',
      loop: loopLines.has(lineNo),
      source_ids: [{ source: 'shmetro-lines', id: String(meta.line_no) }],
      color: meta.color,
      // Numbered lines derive their badge from the name; `浦江线` /
      // `市域机场线` have no numeric code, so they fall back to the official
      // line name as their short label.
      short_name: resolveLineShortName(meta.description),
      extras: { names_source: 'derived' }
    });
  }

  const stopsByLine = new Map<string, StopEncoded[]>();
  for (const [lineNo, seq] of Object.entries(input.lineSequences)) {
    const lineId = `${NETWORK_ID}-line-${lineNo}`;
    const unique = seq.filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i);
    const lineStops: StopEncoded[] = [];
    const stopIdByName = new Map<string, string>();

    unique.forEach((s, idx) => {
      const station = resolveStation(s.name, lineNo);
      if (!station) return;
      // Split names: the primary cluster keeps `id-lineNo`; a secondary whose
      // id already ends with the line number (…-14) uses the id itself so we
      // do not produce `…-14-14`.
      const stopId =
        splitNames.has(s.name) && station.id.endsWith(`-${lineNo}`)
          ? station.id
          : `${station.id}-${lineNo}`;
      stopIdByName.set(s.name, stopId);
      lineStops.push({
        id: stopId,
        station_id: station.id,
        line_id: lineId,
        sequence: idx,
        is_terminal: idx === 0 || idx === unique.length - 1,
        source_id: s.code
      });
    });
    const flatNames = unique.map((s) => s.name).filter((n) => stopIdByName.has(n));
    const getXY = (n: string) => xyByName.get(`${n}|${lineNo}`) ?? xyByName.get(n);
    const linePatterns = reconstructPatterns(
      lineId,
      lineNo,
      flatNames,
      input.lineNotes?.[lineNo],
      stopIdByName,
      getXY
    );
    patterns.push(...linePatterns);

    stops.push(...lineStops);
    stopsByLine.set(lineId, lineStops);

    for (const pattern of linePatterns) {
      for (let i = 0; i < pattern.stop_ids.length - 1; i++) {
        const aId = pattern.stop_ids[i];
        const bId = pattern.stop_ids[i + 1];
        const aStop = lineStops.find((s) => s.id === aId);
        const bStop = lineStops.find((s) => s.id === bId);
        if (!aStop || !bStop) continue;
        const key = `${aId}|${bId}`;
        if (segmentByPair.has(key)) continue;
        segmentByPair.set(key, {
          id: `${NETWORK_ID}-seg-${aId}-${bId}`,
          line_id: lineId,
          from_stop_id: aId,
          to_stop_id: bId,
          from_station_id: aStop.station_id,
          to_station_id: bStop.station_id,
          direction: 'both',
          travel_time_seconds: DEFAULT_SEGMENT_SECONDS,
          travel_time_source: 'estimated' as const,
          source_id: aStop.source_id
        });
      }
    }
  }

  const patternsByLine = new Map<string, PatternEncoded[]>();
  for (const p of patterns) {
    const arr = patternsByLine.get(p.line_id) ?? [];
    arr.push(p);
    patternsByLine.set(p.line_id, arr);
  }

  // Build timetables from the official per-line first/last train tables.
  const timetables: TimetableEncoded[] = [];
  const usedTtIds = new Set<string>();
  for (const [lineNo, rows] of Object.entries(input.fltimeRows)) {
    const lineId = `${NETWORK_ID}-line-${lineNo}`;
    const lineStops = stopsByLine.get(lineId) ?? [];
    const linePatterns = patternsByLine.get(lineId) ?? [];
    const stopByName = (name: string) => {
      const station = resolveStation(name, lineNo);
      return station ? lineStops.find((s) => s.station_id === station.id) : undefined;
    };

    for (const row of rows) {
      const station = resolveStation(row.stationName.trim(), lineNo);
      if (!station) continue;
      const stop = lineStops.find((s) => s.station_id === station.id);
      if (!stop) continue;

      const { dest, origin } = parseDirectionLabel(row.directionLabel);
      const destStop = dest ? stopByName(dest) : undefined;
      const originStop = origin ? stopByName(origin) : undefined;

      let pattern = destStop
        ? (linePatterns.find(
            (p) =>
              p.stop_ids.includes(stop.id) &&
              p.stop_ids.includes(destStop.id) &&
              (p.terminal_stop_id === destStop.id || p.origin_stop_id === destStop.id)
          ) ??
          linePatterns.find(
            (p) => p.stop_ids.includes(stop.id) && p.stop_ids.includes(destStop.id)
          ))
        : originStop
          ? linePatterns.find(
              (p) =>
                p.stop_ids.includes(stop.id) &&
                p.stop_ids.includes(originStop.id) &&
                (p.terminal_stop_id === originStop.id || p.origin_stop_id === originStop.id)
            )
          : undefined;

      let destinationStop = destStop;
      if (!destinationStop && originStop) {
        pattern ??= linePatterns.find(
          (p) => p.stop_ids.includes(stop.id) && p.stop_ids.includes(originStop.id)
        );
        if (pattern) {
          destinationStop =
            originStop.id === pattern.origin_stop_id
              ? lineStops.find((s) => s.id === pattern!.terminal_stop_id)
              : originStop.id === pattern.terminal_stop_id
                ? lineStops.find((s) => s.id === pattern!.origin_stop_id)
                : lineStops.find((s) => s.id === pattern!.terminal_stop_id);
        }
      }
      if (!destinationStop) {
        pattern ??= linePatterns.find((p) => p.stop_ids.includes(stop.id));
        destinationStop = pattern
          ? lineStops.find((s) => s.id === pattern!.terminal_stop_id)
          : undefined;
      }
      pattern ??= linePatterns.find((p) => p.stop_ids.includes(stop.id));
      if (!destinationStop || !pattern) continue;

      const last = buildLastTrainArray(row.lastTime, decodeAdjust(row.adjust));
      const loopDir = detectLoopDirection(row.directionLabel);
      const isLoop = loopLines.has(lineNo);
      timetables.push({
        id: makeUniqueTimetableId(
          usedTtIds,
          NETWORK_ID,
          `${station.id.slice(NETWORK_ID.length + 1)}-${lineNo}`,
          isLoop ? (loopDir ?? 'loop') : destinationStop.station_id.slice(NETWORK_ID.length + 1),
          row.directionLabel
        ),
        station_id: station.id,
        stop_id: stop.id,
        line_id: lineId,
        station_code: stop.source_id,
        source_id: stop.source_id,
        destination_stop_id: isLoop ? undefined : destinationStop.id,
        origin_stop_id: originStop?.id,
        pattern_id: pattern.id,
        direction_type: loopDir ?? (isLoop ? 'linear' : undefined),
        direction_label: row.directionLabel,
        first_train: [row.firstTime],
        last_train: last,
        service: 'all_days'
      });
    }
  }

  // Derive segment times from last-train chains, per pattern.
  const derived = deriveSegmentTimes(patterns, stops, timetables, {});
  const finalSegments = applyDerivedTimes([...segmentByPair.values()], derived);

  const finalTimetables = timetables.map(normalizeTimetableTimes).filter(hasValidTimes);
  const stations = applyTimetableServiceStatus(
    [...stationMap.values()],
    stops,
    finalTimetables,
    []
  );

  return {
    network: {
      id: NETWORK_ID,
      name: '上海地铁',
      names: { zh: '上海地铁', en: 'Shanghai Metro' },
      city: {
        id: 'CN-31',
        name: { zh: '上海', en: 'Shanghai' },
        country: 'CN',
        population: 24870895,
        area: 6341,
        location: { type: 'Point', coordinates: [121.469166666, 31.2325] }
      },
      country_code: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      coordinate_system: 'gcj02',
      default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
      routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 }
    },
    lines: lineRecords,
    stations,
    stops,
    patterns,
    segments: finalSegments,
    transfers: deriveTransfers(stations, stops),
    timetables: finalTimetables,
    officialLocations
  };
}
