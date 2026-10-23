import {
  applyTimetableServiceStatus,
  asciiSlug,
  cleanTime,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  parsePixel,
  parseSlCoord,
  pinyinToEnglish,
  placeholderCity,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, NbLineRecord, NingboSources } from './fetch.js';

const NETWORK_ID = 'cn-ningbo';
const NB_SOURCE = 'nbmetro-station-stat';
const AMAP_SOURCE = 'amap-subway-3302';

/**
 * The official feed's direction labels do not always match the station names
 * it publishes:
 *
 * - Line 12 spells its origin `小洋红` instead of `小洋江` (a typo — one
 *   station on the same line spells it correctly).
 * - Line 2 kept the pre-2022 terminal name `栎社机场` in the direction label
 *   after the station was renamed to `栎社国际机场`; one record even appends
 *   `方向` to it.
 *
 * Both are mapped back to the station name published in the same feed.
 */
const DESTINATION_FIXUPS: Record<string, string> = {
  小洋红: '小洋江',
  栎社机场: '栎社国际机场',
  栎社机场方向: '栎社国际机场'
};

/** Normalise a direction label to the station name it refers to. */
function normalizeDestination(raw: string): string {
  const trimmed = raw.trim();
  const noDirection = trimmed.replace(/方向$/, '').trim();
  return DESTINATION_FIXUPS[noDirection] ?? DESTINATION_FIXUPS[trimmed] ?? noDirection;
}

/**
 * Line 8's eastern extension station. The operator keeps it off its topology
 * feed (it has no timetable and no route) but publishes it on the official
 * network map marked `暂不开通` (not yet open) — the map renders it as the 19th
 * stop, beyond the current terminus 寒松路.
 */
const NOT_YET_OPEN: { name: string; line: string; pinyin: string } = {
  name: '下应南',
  line: '8',
  pinyin: 'XiaYingNan'
};

export interface NingboCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coordinates keyed by station id. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /**
   * Interchange pairs, keyed `stationId|from_line_id|to_line_id`.
   *
   * Every station served by two or more lines gets a complete directional pair
   * set. The operator's `intro` flag marks the interchanges it has open;
   * stations in `pendingInterchanges` are served by several lines but not
   * flagged (市中医院 — the official map notes 「六号线暂不能换乘」).
   */
  interchangePairs: Set<string>;
  /** Station ids whose interchange the operator has not flagged as open. */
  pendingInterchanges: Set<string>;
}

/** Line number of an AMap line (`轨道交通3号线(宁奉城际)` → `3`). */
function amapLineNumber(line: AmapLine): string | undefined {
  const m = /(\d+)\s*号线/.exec(String(line.ln ?? ''));
  return m?.[1];
}

function amapLinesByNumber(amap: NingboSources['amapSubway']): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const num = amapLineNumber(line);
    if (!num || out.has(num)) continue;
    out.set(num, line);
  }
  return out;
}

function amapStationsByName(amap: NingboSources['amapSubway']): Map<string, AmapStation> {
  const out = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!out.has(key)) out.set(key, st);
    }
  }
  return out;
}

/**
 * English label published by the source. AMap's `en` is the operator-curated
 * English name where one exists (`Sakura Park`, `Lishe International Airport`)
 * and a romanisation otherwise (`Xiapu`).
 */
function resolveEnglishName(amap: AmapStation | undefined): string {
  const en = String(amap?.en ?? '').trim();
  if (en && /^[A-Za-z]/.test(en)) return en;
  return pinyinToEnglish(amap?.sp) ?? '';
}

interface Phys {
  /** Official station id (shared by every line the station belongs to). */
  officialId: string;
  id: string;
  zh: string;
  en: string;
  pinyin?: string;
  poiid?: string;
  location?: { lon: number; lat: number };
  schematic?: { x: number; y: number };
  /** Line numbers the station belongs to. */
  lineNums: Set<string>;
  /** The operator marks interchange stations with `intro === "1"`. */
  isInterchange: boolean;
}

function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${short}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

function lineNumberOf(line: NbLineRecord): string {
  return String(line.type).trim();
}

/** Mutable stop draft — `sequence` / `is_terminal` are assigned after the
 * patterns are known, so the canonical `Stop` type cannot be used in place. */
interface StopBuild {
  id: string;
  station_id: string;
  line_id: string;
  sequence: number;
  is_terminal: boolean;
  source_id?: string;
  schematic?: { x: number; y: number; crs: 'schematic' };
  extras?: Record<string, unknown>;
}

export function normalizeNingbo(input: NingboSources): NingboCanonical {
  const amapLines = amapLinesByNumber(input.amapSubway);
  const amapStations = amapStationsByName(input.amapSubway);

  // ── Lines ─────────────────────────────────────────────────────────────────
  const officialLines = [...input.official].sort(
    (a, b) => Number(lineNumberOf(a)) - Number(lineNumberOf(b))
  );
  const lineByNumber = new Map<string, LineEncoded>();
  for (const line of officialLines) {
    const short = lineNumberOf(line);
    if (!short) continue;
    const amap = amapLines.get(short);
    const name = `${short}号线`;
    const enFromAmap = String(amap?.ek ?? amap?.ea ?? '').trim();
    const nameEn = enFromAmap || deriveLineEnglishName(name) || `Line ${short}`;
    const color = hexToCss(amap?.cl);
    // Line 12 is the Xiangshan suburban (市域/郊) railway, not a metro line.
    const mode = short === '12' ? 'suburban_rail' : 'metro';
    lineByNumber.set(short, {
      id: lineIdOf(short),
      name,
      names: { zh: name, en: nameEn },
      aliases: amap?.kn && amap.kn !== name ? [amap.kn] : [],
      color,
      short_name: short,
      mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: NB_SOURCE, id: short },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: enFromAmap ? 'source' : 'derived',
        amap_color: amap?.cl,
        amap_line_name: amap?.ln,
        official_line_number: short,
        ...(short === NOT_YET_OPEN.line ? { not_yet_open_stations: [NOT_YET_OPEN.name] } : {})
      }
    });
  }

  // ── Physical stations ────────────────────────────────────────────────────
  const physByOfficialId = new Map<string, Phys>();
  const usedIds = new Set<string>();

  const ensurePhys = (officialId: string, zhRaw: string): Phys | undefined => {
    const zh = zhRaw.trim();
    if (!zh) return undefined;
    const existing = physByOfficialId.get(officialId);
    if (existing) return existing;
    const amap = amapStations.get(foldStationName(zh));
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const en = resolveEnglishName(amap);
    const slug = stationIdFor(en, zh, pinyin);
    let id = `${NETWORK_ID}-${slug}`;
    // Two stations may romanise identically; keep ids unique and stable.
    if (usedIds.has(id)) id = `${NETWORK_ID}-${slug}-${officialId}`;
    usedIds.add(id);
    const phys: Phys = {
      officialId,
      id,
      zh,
      en,
      pinyin,
      poiid: amap?.poiid || undefined,
      location: parseSlCoord(amap?.sl),
      schematic: parsePixel(amap?.p ?? amap?.rs),
      lineNums: new Set(),
      isInterchange: false
    };
    physByOfficialId.set(officialId, phys);
    return phys;
  };

  for (const line of officialLines) {
    for (const st of line.station ?? []) {
      const phys = ensurePhys(st.id, st.title);
      if (!phys) continue;
      if (st.intro === '1') phys.isInterchange = true;
    }
  }

  // ── Stops, patterns, segments ────────────────────────────────────────────
  const stopsById = new Map<string, StopBuild>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  /** Official station id → stop id, per line (for destination lookup). */
  const stopIdByLineAndName = new Map<string, string>();
  /**
   * Lines a station is listed on but where the operator publishes no service
   * at all (no direction, no first/last train).
   */
  const linesWithoutService = new Map<string, Set<string>>();

  for (const line of officialLines) {
    const short = lineNumberOf(line);
    const lineId = lineIdOf(short);
    const stopIds: string[] = [];
    const stationIds: string[] = [];

    for (const st of line.station ?? []) {
      const phys = physByOfficialId.get(st.id);
      if (!phys) continue;
      // The operator lists 市中医院 on Line 6 but publishes no direction and no
      // timetable for it there, and its network map notes 「六号线暂不能换乘」.
      // A line without published service is not a stop on that line, so the
      // station stays a Line 8 stop only.
      if (!st.sbc1 && !st.mbc1 && !st.sbc2 && !st.mbc2) {
        const set = linesWithoutService.get(phys.id) ?? new Set<string>();
        set.add(short);
        linesWithoutService.set(phys.id, set);
        continue;
      }
      const stopId = stopIdOf(phys.id, short);
      phys.lineNums.add(short);
      stopIds.push(stopId);
      stationIds.push(phys.id);
      stopIdByLineAndName.set(`${short}|${foldStationName(phys.zh)}`, stopId);
      if (!stopsById.has(stopId)) {
        stopsById.set(stopId, {
          id: stopId,
          station_id: phys.id,
          line_id: lineId,
          sequence: 0,
          is_terminal: false,
          source_id: phys.officialId,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            official_station_id: phys.officialId
          }
        });
      }
    }
    if (stopIds.length < 2) continue;

    const first = stopsById.get(stopIds[0]!);
    const last = stopsById.get(stopIds[stopIds.length - 1]!);
    if (first) first.is_terminal = true;
    if (last) last.is_terminal = true;

    const originSlug = asciiSlug(stationIds[0]!.replace(`${NETWORK_ID}-`, ''));
    const terminalSlug = asciiSlug(
      stationIds[stationIds.length - 1]!.replace(`${NETWORK_ID}-`, '')
    );
    const patternId = `${lineId}-pattern-${originSlug}-to-${terminalSlug}`;

    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${short}号线`,
      names: { zh: `${short}号线`, en: lineByNumber.get(short)?.names.en ?? `Line ${short}` },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: NB_SOURCE, id: short }],
      extras: {
        line_short_name: short,
        official_line_number: short
      }
    });

    for (let i = 0; i < stopIds.length - 1; i++) {
      const a = stopIds[i]!;
      const b = stopIds[i + 1]!;
      segments.push({
        id: `${NETWORK_ID}-seg-${a}-${b}`,
        line_id: lineId,
        from_stop_id: a,
        to_stop_id: b,
        from_station_id: stationIds[i]!,
        to_station_id: stationIds[i + 1]!,
        direction: 'both',
        source_id: NB_SOURCE
      });
    }
  }

  // The not-yet-open Line 8 extension stop. The operator keeps it off its
  // topology feed (no timetable, no route) but publishes it on the official
  // network map marked `暂不开通`, rendered directly beyond the current
  // terminus 寒松路. It is modelled as a branch pattern off that terminus,
  // mirroring how the repo records Suzhou's announced extensions: the stop
  // and its segment exist, but the station is `under_construction` and the
  // routing graph drops it.
  {
    const lineId = lineIdOf(NOT_YET_OPEN.line);
    const slug = asciiSlug(NOT_YET_OPEN.pinyin);
    const stationId = `${NETWORK_ID}-${slug}`;
    const stopId = stopIdOf(stationId, NOT_YET_OPEN.line);
    const primary = patterns.find((p) => p.line_id === lineId && p.is_primary);
    const connectorStopId = primary?.terminal_stop_id;
    const connectorStationId = connectorStopId
      ? stopsById.get(connectorStopId)?.station_id
      : undefined;
    if (!usedIds.has(stationId) && connectorStopId && connectorStationId) {
      usedIds.add(stationId);
      const phys: Phys = {
        officialId: '',
        id: stationId,
        zh: NOT_YET_OPEN.name,
        en: pinyinToEnglish(NOT_YET_OPEN.pinyin) ?? '',
        pinyin: NOT_YET_OPEN.pinyin,
        lineNums: new Set([NOT_YET_OPEN.line]),
        isInterchange: false
      };
      physByOfficialId.set(`__not_yet_open__${NOT_YET_OPEN.name}`, phys);
      stopsById.set(stopId, {
        id: stopId,
        station_id: stationId,
        line_id: lineId,
        sequence: 0,
        is_terminal: true,
        extras: {
          line_short_name: NOT_YET_OPEN.line,
          planned_extension: true,
          parent_line_no: NOT_YET_OPEN.line,
          extension_pattern: true,
          official_note: '官网线路图标为「暂不开通」，官方拓扑接口未收录'
        }
      });
      patterns.push({
        id: `${lineId}-pattern-ext-${slug}`,
        line_id: lineId,
        name: `${NOT_YET_OPEN.line}号线延线`,
        names: {
          zh: `${NOT_YET_OPEN.line}号线延线`,
          en: `Line ${NOT_YET_OPEN.line} Extension`
        },
        stop_ids: [connectorStopId, stopId],
        origin_stop_id: connectorStopId,
        terminal_stop_id: stopId,
        is_primary: false,
        junction_stop_id: connectorStopId,
        source_ids: [{ source: NB_SOURCE, id: NOT_YET_OPEN.name }],
        extras: {
          pattern_status: 'under_construction',
          parent_line_id: lineId,
          connector_station_id: connectorStationId,
          official_extension: true,
          line_short_name: NOT_YET_OPEN.line
        }
      });
      segments.push({
        id: `${NETWORK_ID}-seg-${connectorStopId}-${stopId}`,
        line_id: lineId,
        from_stop_id: connectorStopId,
        to_stop_id: stopId,
        from_station_id: connectorStationId,
        to_station_id: stationId,
        direction: 'both',
        source_id: NB_SOURCE
      });
    }
  }

  // Unique sequence per line: the primary pattern first, then branch patterns.
  {
    const assigned = new Set<string>();
    const lineNext = new Map<string, number>();
    const ordered = [...patterns].sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return b.stop_ids.length - a.stop_ids.length;
    });
    for (const pattern of ordered) {
      let next = lineNext.get(pattern.line_id) ?? 0;
      for (const stopId of pattern.stop_ids) {
        const stop = stopsById.get(stopId);
        if (!stop || assigned.has(stopId)) continue;
        stop.sequence = next++;
        assigned.add(stopId);
      }
      lineNext.set(pattern.line_id, next);
    }
  }

  // ── Timetables ───────────────────────────────────────────────────────────
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  /** Direction labels that could not be resolved to a station on the line. */
  const unresolvedDestinations = new Set<string>();

  const destinationStopId = (
    short: string,
    rawDest: string | null | undefined
  ): string | undefined => {
    if (!rawDest) return undefined;
    const fixed = normalizeDestination(rawDest);
    if (!fixed) return undefined;
    return stopIdByLineAndName.get(`${short}|${foldStationName(fixed)}`);
  };

  for (const line of officialLines) {
    const short = lineNumberOf(line);
    const lineId = lineIdOf(short);
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!pattern) continue;
    for (const st of line.station ?? []) {
      const phys = physByOfficialId.get(st.id);
      if (!phys) continue;
      const stopId = stopIdOf(phys.id, short);
      const directions: { fx: string | null; sbc: string | null; mbc: string | null }[] = [
        { fx: st.fx1, sbc: st.sbc1, mbc: st.mbc1 },
        { fx: st.fx2, sbc: st.sbc2, mbc: st.mbc2 }
      ];
      directions.forEach((dir, index) => {
        const first = cleanTime(dir.sbc ?? undefined);
        const last = cleanTime(dir.mbc ?? undefined);
        if (!first && !last) return;
        const destStopId = destinationStopId(short, dir.fx);
        if (!destStopId) {
          // The direction label does not resolve to a station on this line —
          // surface it instead of silently dropping the timetable.
          unresolvedDestinations.add(`${short}|${dir.fx ?? '-'}`);
          return;
        }
        const destName = dir.fx ? normalizeDestination(dir.fx) : '';
        const id = `${phys.id}-${short}-${index + 1}-to-${destStopId.replace(`${NETWORK_ID}-`, '')}`;
        if (ttIds.has(id)) return;
        ttIds.add(id);
        timetables.push({
          id,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          source_id: NB_SOURCE,
          destination_stop_id: destStopId,
          origin_stop_id: pattern.origin_stop_id,
          pattern_id: pattern.id,
          direction_type: 'linear',
          direction_label: destName ? `往${destName}方向` : undefined,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          service: 'all_days',
          extras: {
            calendar: 'weekday',
            dest_name: destName,
            line_short_name: short,
            official_station_id: phys.officialId,
            direction_index: index + 1
          }
        });
      });
    }
  }

  // ── Stations ─────────────────────────────────────────────────────────────
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const stations: StationEncoded[] = [];
  for (const phys of physByOfficialId.values()) {
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (location) officialLocations.set(phys.id, location);
    const notYetOpen = phys.officialId === '';
    const unserved = linesWithoutService.get(phys.id) ?? new Set<string>();
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en },
      location,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: notYetOpen ? 'under_construction' : 'operating',
      source_ids: [
        ...(phys.officialId ? [{ source: NB_SOURCE, id: phys.officialId }] : []),
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : []),
        { source: NB_SOURCE, id: phys.zh }
      ],
      extras: {
        official_station_id: phys.officialId || undefined,
        pinyin: phys.pinyin,
        amap_poiid: phys.poiid,
        lines: [...phys.lineNums].sort((a, b) => Number(a) - Number(b)),
        is_interchange: phys.isInterchange,
        names_source: phys.en ? 'source' : 'derived',
        location_source: location ? 'amap_subway' : undefined,
        ...(unserved.size > 0
          ? {
              lines_listed_without_service: [...unserved].sort((a, b) => Number(a) - Number(b)),
              service_note: '官网在该线未发布首末班时刻，线路图标注「暂不能换乘」'
            }
          : {}),
        ...(notYetOpen ? { planned_extension: true } : {})
      }
    });
  }

  const stops: StopEncoded[] = [...stopsById.values()].map((s) => ({
    id: s.id,
    station_id: s.station_id,
    line_id: s.line_id,
    sequence: s.sequence,
    is_terminal: s.is_terminal,
    source_id: s.source_id,
    schematic: s.schematic,
    extras: s.extras
  }));

  // A station that sits on a line publishing first/last trains but owns no
  // timetable of its own is not in passenger service on that line.
  const withStatus = applyTimetableServiceStatus(stations, stops, timetables.filter(hasValidTimes));

  // ── Interchange pairs ────────────────────────────────────────────────────
  // The canonical model treats a station served by two or more lines as an
  // interchange and requires a complete set of directional transfer pairs.
  //
  // The operator's `intro === "1"` flag marks the interchanges it has open;
  // it is set on both lines of the 29 stations it publishes as interchanges.
  // 市中医院 is listed on Line 6 as well, but the operator publishes no Line 6
  // timetable there and its network map notes 「六号线暂不能换乘」 — so it has
  // no Line 6 stop and is a Line 8 station only.
  const flaggedLinesByStation = new Map<string, Set<string>>();
  for (const line of officialLines) {
    const short = lineNumberOf(line);
    for (const st of line.station ?? []) {
      if (st.intro !== '1') continue;
      const phys = physByOfficialId.get(st.id);
      if (!phys) continue;
      const set = flaggedLinesByStation.get(phys.id) ?? new Set<string>();
      set.add(short);
      flaggedLinesByStation.set(phys.id, set);
    }
  }
  /** Stations served by more than one line, i.e. the interchanges. */
  const interchangeLinesByStation = new Map<string, Set<string>>();
  for (const phys of physByOfficialId.values()) {
    if (phys.lineNums.size > 1) interchangeLinesByStation.set(phys.id, phys.lineNums);
  }
  const interchangePairs = new Set<string>();
  /** Stations the operator does not flag as an interchange (yet). */
  const pendingInterchanges = new Set<string>();
  for (const [stationId, shorts] of interchangeLinesByStation) {
    const list = [...shorts].sort((a, b) => Number(a) - Number(b));
    const flagged = flaggedLinesByStation.get(stationId) ?? new Set<string>();
    if (list.length > 1 && flagged.size < list.length) pendingInterchanges.add(stationId);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = lineIdOf(list[i]!);
        const b = lineIdOf(list[j]!);
        interchangePairs.add(`${stationId}|${a}|${b}`);
        interchangePairs.add(`${stationId}|${b}|${a}`);
      }
    }
  }

  if (unresolvedDestinations.size > 0) {
    console.warn(
      `  nbmetro: unresolved direction labels: ${[...unresolvedDestinations].join(', ')}`
    );
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '宁波轨道交通',
    names: { zh: '宁波轨道交通', en: 'Ningbo Rail Transit' },
    city: placeholderCity('CN-3302'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑、逐方向逐站首末班与换乘站结构来自宁波轨道交通官网 station.php?stat（9 线、210 个线站记录、179 座车站、30 座换乘站）；官方 OD 票价来自 station.php?gostationTest。坐标、线网示意图、线色与部分英文名来自官网线网图所使用的 AMap Subway 数据。官网仅使用 HTTP（HTTPS 证书已过期）。8 号线下应南站官网标注「暂不开通」，记为在建车站。'
  };

  return {
    network,
    lines: [...lineByNumber.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: withStatus.sort((a, b) => a.id.localeCompare(b.id)),
    stops: stops.sort((a, b) => a.id.localeCompare(b.id)),
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: timetables.filter(hasValidTimes),
    officialLocations,
    interchangePairs,
    pendingInterchanges
  };
}
