import {
  asciiSlug,
  deriveLineEnglishName,
  foldStationName,
  hexToCss,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  parsePixel,
  parseSlCoord,
  placeholderCity,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, ShenyangSources, SymStation } from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_ID, type ShenyangLineConfig, splitCamelPinyin } from './lines.js';
import { buildDirectionTimetables, resolveDirections } from './timetables.js';

const NETWORK_ID = 'cn-shenyang';
const SYM_SOURCE = 'symtc-cocc-api';
const AMAP_SOURCE = 'amap-subway-2101';

export interface ShenyangCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coordinates keyed by canonical station id. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Interchange stations: canonical station id → the line ids it serves. */
  interchanges: Map<string, string[]>;
  /** Per canonical line id: the line's stops in official order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Per canonical line id: the line's station names in official order. */
  stationNamesByLineId: Map<string, string[]>;
}

function amapLineByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln) continue;
    if (!byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}

function amapStationByFold(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byFold = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

/**
 * Registry entry for an official line.
 *
 * The official feed is authoritative; the static registry only supplies the
 * canonical id slug and the planner's vehicle-name fragment. An unknown
 * official line still gets a usable config derived from its own name.
 */
function configFor(officialId: string, officialName: string): ShenyangLineConfig {
  const known = LINE_CONFIG_BY_OFFICIAL_ID.get(officialId);
  if (known) return known;
  return {
    short: officialName.replace(/号线$/, '') || officialId,
    name: officialName,
    slug: asciiSlug(officialName) || officialId,
    mode: 'metro',
    baiduNameHint: `地铁${officialName}`
  };
}

export interface NormalizeInput {
  sources: ShenyangSources;
}

export function normalizeShenyang(input: NormalizeInput): ShenyangCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);

  type Phys = {
    id: string;
    zh: string;
    /** Official per-line station ids of this physical station. */
    officialIds: string[];
    /** Official per-line station code of the first line that serves it. */
    officialCode: string;
    /** CamelCase pinyin as published by the operator (or AMap). */
    camelPinyin?: string;
    /** Word-separated pinyin, used as the romanised label fallback. */
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    lines: Set<string>;
  };

  const physByName = new Map<string, Phys>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const usedSlugs = new Set<string>();

  /** Stable slug for a physical station, unique across the network. */
  const slugFor = (camel: string | undefined, zh: string, officialCode: string): string => {
    const base = asciiSlug(camel ?? '') || asciiSlug(zh) || `station-${officialCode}`;
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    const disambiguated = `${base}-${officialCode}`;
    usedSlugs.add(disambiguated);
    return disambiguated;
  };

  const ensurePhys = (station: SymStation, lineId: string): Phys | undefined => {
    const zh = station.station_name.trim();
    if (!zh) return undefined;
    let phys = physByName.get(zh);
    if (!phys) {
      const desc = sources.descByStationId.get(station.station_id);
      const amap = amapStationIndex.get(foldStationName(zh));
      const camel =
        String(desc?.station_eng_name ?? '').trim() || String(amap?.sp ?? '').trim() || undefined;
      const pinyin = camel ? splitCamelPinyin(camel) : undefined;
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      phys = {
        id: `${NETWORK_ID}-${slugFor(camel, zh, station.station_code)}`,
        zh,
        officialIds: [],
        officialCode: station.station_code,
        camelPinyin: camel,
        pinyin,
        location: loc,
        schematic: pix,
        lines: new Set()
      };
      physByName.set(zh, phys);
      if (loc) officialLocations.set(phys.id, { ...loc, crs: 'gcj02' });
    }
    phys.officialIds.push(station.station_id);
    phys.lines.add(lineId);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { officialId: string; cfg: ShenyangLineConfig }[] = [];

  const officialLines = [...sources.lines].sort((a, b) => a.line_id.localeCompare(b.line_id));
  for (const official of officialLines) {
    const cfg = configFor(official.line_id, official.line_name);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    const amap = amapLineIndex.get(official.line_name);
    const meta = sources.lineMeta.get(official.line_id);
    const nameEn =
      amap?.multilang?.ln?.en ?? deriveLineEnglishName(official.line_name) ?? `Line ${cfg.short}`;
    const short = resolveLineShortName(official.line_name, cfg.short);
    const line: LineEncoded = {
      id,
      name: official.line_name,
      names: { zh: official.line_name, en: nameEn },
      aliases: [],
      // The operator's own colour wins; AMap's colour is a different palette.
      color: hexToCss(meta?.line_color) ?? hexToCss(amap?.cl),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: SYM_SOURCE, id: official.line_id },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.line_id,
        line_mileage_km: meta?.line_mileage,
        station_count: meta?.station_num,
        opened_at: meta?.open_tm,
        closes_at: meta?.close_tm,
        amap_color: amap?.cl,
        baidu_name_hint: cfg.baiduNameHint
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ officialId: official.line_id, cfg });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const stationNamesByLineId = new Map<string, string[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  /** Canonical line id → the stop id of each official station id. */
  const stopIdByOfficialStationId = new Map<string, string>();
  /** Canonical station id → official per-line station code. */
  const stationCodeByStationId = new Map<string, string>();
  /** Canonical stop id → canonical station id. */
  const stationIdByStopId = new Map<string, string>();
  /** Canonical station id → Chinese name. */
  const nameByStationId = new Map<string, string>();
  const interchangeLines = new Map<string, Set<string>>();

  for (const { officialId, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const officialStations = sources.stationsByLine.get(officialId) ?? [];
    if (officialStations.length < 2) {
      console.log(`  ${cfg.name}: only ${officialStations.length} stops, skipped`);
      continue;
    }

    const lineStops: StopEncoded[] = [];
    const linePhys: Phys[] = [];

    for (let i = 0; i < officialStations.length; i++) {
      const station = officialStations[i]!;
      const phys = ensurePhys(station, lineId);
      if (!phys) continue;

      const stopId = `${phys.id}-${cfg.short}`;
      stopIdByOfficialStationId.set(`${officialId}:${station.station_id}`, stopId);
      stationIdByStopId.set(stopId, phys.id);
      nameByStationId.set(phys.id, phys.zh);
      if (!stationCodeByStationId.has(phys.id)) {
        stationCodeByStationId.set(phys.id, station.station_code);
      }

      lineStops.push({
        id: stopId,
        station_id: phys.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === officialStations.length - 1,
        location: phys.location
          ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' }
          : undefined,
        schematic: phys.schematic
          ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
          : undefined,
        source_id: station.station_code,
        extras: {
          line_short_name: cfg.short,
          official_station_id: station.station_id,
          official_line_id: officialId,
          official_sort: station.sort
        }
      });
      linePhys.push(phys);
    }

    if (lineStops.length < 2) continue;
    stopsByLineId.set(lineId, lineStops);
    stationNamesByLineId.set(
      lineId,
      linePhys.map((p) => p.zh)
    );

    const primaryPatternId = `${lineId}-pattern-primary`;
    patterns.push({
      id: primaryPatternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: SYM_SOURCE, id: officialId }],
      extras: {
        line_short_name: cfg.short,
        origin_name: linePhys[0]?.zh,
        terminal_name: linePhys[linePhys.length - 1]?.zh
      }
    });

    for (let i = 0; i + 1 < lineStops.length; i++) {
      const a = lineStops[i]!;
      const b = lineStops[i + 1]!;
      const key = [a.id, b.id].sort().join('|');
      if (segmentKeys.has(key)) continue;
      segmentKeys.add(key);
      segments.push({
        id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        source_id: SYM_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { officialId, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    if (!lineStops) continue;

    const stopIdByStationId = new Map<string, string>();
    for (const s of lineStops) {
      const officialStationId = String(s.extras?.official_station_id ?? '');
      stopIdByStationId.set(officialStationId, s.id);
    }

    const rows = sources.timetables.filter((r) => r.Line_ID === officialId);
    if (rows.length === 0) continue;

    const directions = resolveDirections({
      lineId,
      lineStopIds: lineStops.map((s) => s.id),
      stopIdByStationId,
      stationIdByStopId,
      nameByStationId,
      rows
    });

    const primaryPattern = patterns.find((p) => p.line_id === lineId && p.is_primary);
    if (!primaryPattern) continue;

    for (const direction of directions) {
      // Every direction of a single-chain line rides the line's own alignment,
      // so it attaches to the primary pattern. 3号线's 东延线 (方家栏↔甘官) is
      // such a direction: its stops are a *subset* of the line's stops and it
      // is therefore published as a third destination on the primary
      // alignment rather than as a pattern of its own — a second pattern that
      // shares stops with the primary has to be a one-stop spur, which a
      // short-turn over an existing corridor is not.
      const patternId = primaryPattern.id;

      const records = buildDirectionTimetables(direction, {
        lineId,
        patternId,
        stationCodeByStationId,
        stationIdByStopId,
        sourceId: SYM_SOURCE
      });
      for (const rec of records) {
        if (ttIds.has(rec.id)) continue;
        ttIds.add(rec.id);
        timetables.push(rec);
      }
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  for (const phys of physByName.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (loc) officialLocations.set(phys.id, loc);
    const servedLines = [...phys.lines];
    if (servedLines.length > 1) {
      interchangeLines.set(phys.id, new Set(servedLines));
    }
    stations.push({
      id: phys.id,
      name: phys.zh,
      // English names come from Wikidata (core) with the operator's romanised
      // pinyin as the deterministic fallback.
      names: { zh: phys.zh, en: '' },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: phys.officialIds.map((id) => ({ source: SYM_SOURCE, id })),
      extras: {
        pinyin: phys.pinyin,
        camel_pinyin: phys.camelPinyin,
        official_station_ids: phys.officialIds,
        location_source: 'amap'
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '沈阳地铁',
    names: { zh: '沈阳地铁', en: 'Shenyang Metro' },
    city: placeholderCity('CN-2101'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 600 },
    notes:
      '拓扑（线路、站序、官方线内站码）、线色、里程、开通日期、站名与官方拼音、首末班时刻表与票制均来自沈阳地铁官网 www.symtc.com 的 cocc-website 接口（getLineList / getStationList / getHomePageInitData，后者须用 POST 调用，GET 会返回早于 3 号线东延线开通的旧快照）。官网本身不提供经纬度与换乘步行时间：坐标取自 AMap Subway 2101（GCJ-02，与官方站名逐站一一对应），换乘步行取自百度路径规划 direction/v2/transit 的站厅换乘步行段。3 号线东延线（方家栏↔甘官，2024-12-30 开通）是官方单独发布的一条折返交路（tag_dir=03），其车站与 3 号线主线重合，因此按"同一走廊上的第三个方向"发布——时刻表挂在 3 号线主交路上，终点记为甘官，而不是另建一条交路。首末班时刻表按官方发布的是单一变体，官网对外的时刻表页面为内网 iframe，无法区分工作日与双休日。官方表中个别站点的首/末班存在跳变（延伸段边界），区间时间以末班链派生并做单调性与时长窗口校验，越界值回落到规划器实测值。在建的 6 号线一期、9 号线二期、10 号线二期未建模。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopsByLineId.values()].flat(),
    patterns,
    segments,
    timetables,
    officialLocations,
    interchanges: new Map([...interchangeLines.entries()].map(([k, v]) => [k, [...v]] as const)),
    stopsByLineId,
    stationNamesByLineId
  };
}
