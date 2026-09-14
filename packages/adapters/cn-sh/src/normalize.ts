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
  nameToCode: Record<string, string>;
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
   * Official stationInfo coords as GCJ-02, keyed by Chinese name.
   * Prefers `gao_lng`/`gao_lat` (already GCJ-02); falls back to converting
   * the BD-09 `longitude`/`latitude` pair.
   */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

const NETWORK_ID = 'cn-sh';
const DEFAULT_SEGMENT_SECONDS = 120;

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
  xyByName: Map<string, XY>
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
  const axisA = xyByName.get(main[0]);
  const axisB = xyByName.get(main[1]);
  const pXY = xyByName.get(P);
  const qXY = xyByName.get(Q);
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
  const xyByName = new Map<string, XY>();
  // Official stationInfo coords: `gao_*` is GCJ-02; `longitude`/`latitude` is BD-09.
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  for (const infos of Object.values(input.stations)) {
    for (const info of infos) {
      const name = info.name_cn.trim();
      const id = `${NETWORK_ID}-${slug(info.name_en || name)}`;
      if (!stationMap.has(name)) {
        stationMap.set(name, {
          id,
          name,
          names: { zh: name, en: info.name_en },
          status: 'operating',
          source_ids: [{ source: 'shmetro-stationInfo', id: info.station_code }]
        });
      }
      if (!officialLocations.has(name)) {
        const loc = officialGcj02(info);
        if (loc) officialLocations.set(name, loc);
      }
      if (!xyByName.has(name) && Number.isFinite(info.x) && Number.isFinite(info.y)) {
        xyByName.set(name, { x: info.x, y: info.y });
      }
      codeToStationId.set(info.station_code, id);
    }
  }

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
      const station = stationMap.get(s.name);
      if (!station) return;
      const stopId = `${station.id}-${lineNo}`;
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
    const linePatterns = reconstructPatterns(
      lineId,
      lineNo,
      flatNames,
      input.lineNotes?.[lineNo],
      stopIdByName,
      xyByName
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
    const stopByName = (name: string) =>
      lineStops.find((s) => s.station_id === stationMap.get(name)?.id);

    for (const row of rows) {
      const station = stationMap.get(row.stationName.trim());
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
      routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
      operators: [],
      source: []
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
