import {
  asciiSlug,
  deriveLineEnglishName,
  foldStationName,
  hexToCss,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  placeholderCity,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded
} from '@openmetro/core';
import {
  type AmapStationInfo,
  amapLineByName,
  amapLineColor,
  amapLineEnglishName,
  amapStationsByName
} from './amap.js';
import type { XuzhouSources, XzDropBoxLine } from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_NAME, type XuzhouLineConfig } from './lines.js';

const NETWORK_ID = 'cn-xuzhou';
export const XZ_SOURCE = 'xzdtjt-dropbox';
export const XZ_TIMETABLE_SOURCE = 'xzdtjt-timetable';
export const AMAP_SOURCE = 'amap-subway-3203';

/** A physical station (one name, one coordinate) served by one or more lines. */
interface PhysicalStation {
  id: string;
  zh: string;
  en: string;
  pinyin?: string;
  location?: { lon: number; lat: number };
  schematic?: { x: number; y: number };
  poiid?: string;
  /** Official station ids (one per serving line). */
  officialIds: string[];
  /** The line ids this station serves. */
  lineIds: string[];
}

/** A reference the official route planner accepts for one physical station. */
export interface PlannerStationRef {
  /** Official station id (1…76) the planner expects. */
  officialId: number;
  /** The operator's 0-based line position of that id's line. */
  lineIndex: number;
}

export interface XuzhouCanonical {
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
  /** Physical station → a station id the official planner accepts. */
  plannerRefByStationId: Map<string, PlannerStationRef>;
}

/**
 * Registry entry for an official line.
 *
 * The operator's `dropBox` tree is authoritative for the line list; the static
 * registry only supplies the canonical id slug, the planner's line position
 * and the planner's vehicle-name fragment. An unknown line still gets a usable
 * config derived from its own name.
 */
function configFor(official: XzDropBoxLine): XuzhouLineConfig {
  const name = official.label.trim();
  const known = LINE_CONFIG_BY_OFFICIAL_NAME.get(name);
  if (known) return known;
  const short = name.replace(/号线$/, '') || official.value;
  return {
    short,
    name,
    slug: asciiSlug(short) || official.value,
    mode: 'metro',
    // Unknown lines fall back to their position in the operator's own list.
    officialIndex: -1,
    baiduNameHint: `地铁${name}`
  };
}

export interface NormalizeInput {
  sources: XuzhouSources;
}

export function normalizeXuzhou(input: NormalizeInput): XuzhouCanonical {
  const { sources } = input;
  const amapLines = amapLineByName(sources.amap);

  const physByName = new Map<string, PhysicalStation>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensurePhys = (zh: string, amap: AmapStationInfo | undefined): PhysicalStation => {
    const key = foldStationName(zh);
    const existing = physByName.get(key);
    if (existing) {
      // Prefer the richer AMap record when another line contributes it.
      if (!existing.en && amap?.english) existing.en = amap.english;
      if (!existing.pinyin && amap?.pinyin) existing.pinyin = amap.pinyin;
      if (!existing.location && amap?.location) existing.location = amap.location;
      if (!existing.schematic && amap?.schematic) existing.schematic = amap.schematic;
      if (!existing.poiid && amap?.poiid) existing.poiid = amap.poiid;
      return existing;
    }
    const en = amap?.english ?? '';
    const pinyin = amap?.pinyin;
    const phys: PhysicalStation = {
      id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
      zh,
      en,
      pinyin,
      location: amap?.location,
      schematic: amap?.schematic,
      poiid: amap?.poiid,
      officialIds: [],
      lineIds: []
    };
    physByName.set(key, phys);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { official: XzDropBoxLine; cfg: XuzhouLineConfig }[] = [];

  for (const official of sources.dropBox) {
    const cfg = configFor(official);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    const amap = amapLines.get(official.label.trim());
    const nameEn =
      amapLineEnglishName(amap) ??
      deriveLineEnglishName(official.label, cfg.short) ??
      `Line ${cfg.short}`;
    const short = resolveLineShortName(official.label, cfg.short);
    const line: LineEncoded = {
      id,
      name: official.label.trim(),
      names: { zh: official.label.trim(), en: nameEn },
      aliases: [],
      color: hexToCss(amapLineColor(amap)),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: XZ_SOURCE, id: official.value },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_number: Number(official.value),
        planner_line_index: cfg.officialIndex,
        baidu_name_hint: cfg.baiduNameHint,
        ...(amapLineColor(amap) ? { amap_color: amapLineColor(amap) } : {})
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ official, cfg });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const stationNamesByLineId = new Map<string, string[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const plannerRefByStationId = new Map<string, PlannerStationRef>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const officialStations = official.children ?? [];
    if (officialStations.length < 2) {
      console.log(`  ${cfg.name}: only ${officialStations.length} stops, skipped`);
      continue;
    }

    const amap = amapLines.get(official.label.trim());
    const amapStations = amapStationsByName(amap);

    const lineStops: StopEncoded[] = [];
    const linePhys: PhysicalStation[] = [];

    for (let i = 0; i < officialStations.length; i++) {
      const station = officialStations[i]!;
      const zh = station.label.trim();
      if (!zh) continue;
      const info = amapStations.get(foldStationName(zh));
      const phys = ensurePhys(zh, info);
      phys.officialIds.push(station.value);
      if (!phys.lineIds.includes(lineId)) phys.lineIds.push(lineId);

      // The planner accepts the id of the line the station belongs to; keep the
      // first one as the representative reference.
      if (!plannerRefByStationId.has(phys.id)) {
        plannerRefByStationId.set(phys.id, {
          officialId: Number(station.value),
          lineIndex: cfg.officialIndex
        });
      }

      lineStops.push({
        id: `${phys.id}-${cfg.short}`,
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
        source_id: station.value,
        extras: { line_short_name: cfg.short, official_station_id: Number(station.value) }
      });
      linePhys.push(phys);
    }

    if (lineStops.length < 2) continue;
    stopsByLineId.set(lineId, lineStops);
    stationNamesByLineId.set(
      lineId,
      linePhys.map((p) => p.zh)
    );

    const patternId = `${lineId}-pattern-${asciiSlug(lineStops[0]!.id)}-to-${asciiSlug(
      lineStops[lineStops.length - 1]!.id
    )}`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: XZ_SOURCE, id: official.value }],
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
        source_id: XZ_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { official, cfg } of lineCfgs) {
    const lineNumber = Number(official.value);
    const rows = sources.timetables.get(lineNumber);
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!rows || !lineStops || !pattern) continue;

    const lineNames = stationNamesByLineId.get(lineId) ?? [];

    // The sheet lists the stations in the operator's own line order, which is
    // the same order as the `dropBox` tree. The two direction columns head
    // toward the last and the first station respectively.
    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;
    const directions: {
      first?: string;
      last?: string;
      label?: string;
      destStop: StopEncoded;
      /** Which sheet column this direction comes from. */
      column: 1 | 2;
    }[] = [
      { column: 1, label: rows[0]?.direction1, destStop: lastStop },
      { column: 2, label: rows[0]?.direction2, destStop: firstStop }
    ];

    for (let i = 0; i < lineStops.length; i++) {
      const stop = lineStops[i]!;
      const row = rows[i];
      if (!row) continue;
      // Cross-check the sheet against the tree: the row's station name must
      // fold onto the stop's station name.
      const stopName = lineNames[i] ?? '';
      if (foldStationName(row.stationName) !== foldStationName(stopName)) continue;

      for (const dir of directions) {
        const first = dir.column === 1 ? row.first1 : row.first2;
        const last = dir.column === 1 ? row.last1 : row.last2;
        if (!first || !last) continue;
        const id = `${NETWORK_ID}-${stop.id}-to-${asciiSlug(dir.destStop.id)}-primary`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        const destStation = physByName.get(foldStationName(lineNames[dir.destStop.sequence] ?? ''));
        timetables.push({
          id,
          station_id: stop.station_id,
          stop_id: stop.id,
          line_id: stop.line_id,
          station_code: stop.source_id,
          source_id: XZ_TIMETABLE_SOURCE,
          destination_stop_id: dir.destStop.id,
          pattern_id: pattern.id,
          direction_type: 'linear',
          // The sheet's column header already reads `开往<终点站>`.
          direction_label: dir.label,
          first_train: [first],
          last_train: [last],
          extras: {
            service: 'primary',
            direction: dir.label,
            destination_name: destStation?.zh,
            source_note:
              '逐站首末班取自官网 /1/54/timetable 的官方时刻表 HTML 表格（非图片、无需 OCR）；官网仅发布单一日制，未区分工作日与双休日，故 first_train/last_train 长度为 1。'
          }
        });
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
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: {
        zh: phys.zh,
        en: phys.en && /^[A-Za-z]/.test(phys.en) && !/[一-鿿]/.test(phys.en) ? phys.en : ''
      },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: phys.officialIds.map((id) => ({ source: XZ_SOURCE, id })),
      extras: {
        pinyin: phys.pinyin,
        official_station_ids: phys.officialIds.map((id) => Number(id)),
        ...(phys.poiid ? { amap_poiid: phys.poiid } : {}),
        line_ids: phys.lineIds
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '徐州地铁',
    names: { zh: '徐州地铁', en: 'Xuzhou Metro' },
    city: placeholderCity('CN-3203'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/站序/换乘关系/出入口来自官网 xzdtjt.com 首页内嵌的 dropBox 树（全局站点 ID 1–76，按线连续分配；换乘站按线各有一个 ID）。逐站首末班来自官网 /1/54/timetable 的官方时刻表 HTML 表格（非图片，未做 OCR）；官网仅发布单一日制，未区分工作日与双休日。OD 票价直接来自官网 /1/53/lineSearch 的站到站票价查询（运营方按最短路径里程计价：起步 2 元/6 km，6–18 km 每 1 元 6 km，18–34 km 每 1 元 8 km，34–44 km 每 1 元 10 km，44–59 km 每 1 元 15 km，59 km 以上每 1 元 20 km），另有市民卡 9.5 折、60–69 岁老人与学生 5 折、70 岁以上与身高 1.3 m 以下儿童免费、轨道换公交 60 分钟内优惠 1 元。坐标/英文名/线色/示意网格来自 AMap Subway 3203（multilang.n.en 提供 76/76 真实英文名）。区间时间距离与换乘步行来自百度路径规划 direction/v2/transit；换乘步行按「离枢纽最近的站厅步行段」测得全部 12 座换乘站，其中 8 座共用规划器的同一组建模值（站厅换乘 231 米 / 193 秒），其余 4 座为更长的步行（309 米 / 258 秒、554 米 / 462 秒）；三档均按规划器 1.2 m/s 的步速换算，并非逐站实测耗时。官网前置创宇盾 WAF，无公开 JSON API，全部数据由服务端渲染 HTML 解析而来。在建的 4 号线一期、5 号线一期无结构化站表，未建模。'
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
    interchanges: new Map(
      [...physByName.values()]
        .filter((p) => p.lineIds.length > 1)
        .map((p) => [p.id, [...p.lineIds]] as const)
    ),
    stopsByLineId,
    stationNamesByLineId,
    plannerRefByStationId
  };
}
