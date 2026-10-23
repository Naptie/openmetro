/**
 * Canonical normalisation for cn-guiyang.
 *
 * Source of truth for the topology is the operator's own station list on
 * `https://www.gyurt.com/subwayInquiry.html`; the line order in that page is
 * the operator's line order. AMap contributes the GCJ-02 coordinates, the
 * schematic pixels, the English names and the per-line station codes; the
 * operator's planner contributes the first/last trains, the per-segment ride
 * times and distances and the interchange walk distances.
 */
import {
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
import type { AmapLine, AmapStation, AmapSubwayDoc, GuiyangSources } from './fetch.js';
import { guiyangLineByOfficialId, guiyangLineId } from './lines.js';
import { foldGuiyangStationName, guiyangStationName } from './names.js';
import type { HarvestedSegment } from './segments.js';
import type { HarvestedTimetable } from './timetables.js';
import type { HarvestedInterchange } from './transfers.js';

const NETWORK_ID = 'cn-guiyang';
export const GY_SOURCE = 'gyurt-subway-inquiry';
export const GY_PLANNER_SOURCE = 'gyurt-planner';
export const AMAP_SOURCE = 'amap-subway-5201';

export interface GuiyangCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** Canonical station id → the operator's coordinate string (`lat,lng`). */
  officialCoords: Map<string, string>;
  /** Interchange stations: canonical station id → the line ids it serves. */
  interchanges: Map<string, string[]>;
  /** Per canonical line id: the line's stops in official line order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Canonical station id → the operator's line ids it appears on. */
  lineIdsByStation: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// English names
// ---------------------------------------------------------------------------

/**
 * English names as printed on the operator's network map.
 *
 * AMap publishes the same names, but eight stations carry an older or more
 * verbose wording there. The network map is the operator's own publication and
 * wins.
 */
const ENGLISH_NAME_OVERRIDES: Record<string, string> = {
  白鹭湖: 'Bailu Lake',
  '东风(贵黔医院)': 'Dongfeng (Guiqian Hospital)',
  '四方河(省中医院)': 'Sifanghe (Guizhou Provincial Hospital of Traditional Chinese Medicine)',
  师范学院: 'Guizhou Normal University',
  孔学堂: 'Kongxuetang',
  小孟工业园: 'Xiaomai Industrial Park',
  省人民医院: 'Provincial General Hospital',
  兴筑路: 'Xingzhu Road'
};

function amapLineByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln && !byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}

function amapStationByFold(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byFold = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldGuiyangStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

export interface NormalizeInput {
  sources: GuiyangSources;
  /** Per-station, per-direction first/last trains from the planner. */
  harvestedTimetables?: HarvestedTimetable[];
  /** Per-adjacent-pair ride times and distances from the planner. */
  harvestedSegments?: HarvestedSegment[];
  /** Interchange walk distances from the planner. */
  harvestedInterchanges?: HarvestedInterchange[];
}

export function normalizeGuiyang(input: NormalizeInput): GuiyangCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);

  // ---- Group the operator's stops by line, preserving the published order ---
  const stopsByOfficialId = new Map<string, typeof sources.officialStops>();
  for (const stop of sources.officialStops) {
    const list = stopsByOfficialId.get(stop.lineId) ?? [];
    list.push(stop);
    stopsByOfficialId.set(stop.lineId, list);
  }

  type Phys = {
    id: string;
    zh: string;
    en: string;
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    /** AMap per-line station codes this station carries. */
    codes: string[];
    /** The operator's own coordinate string — the planner API key. */
    coord: string;
    /** The operator's spelling of the name, before normalisation. */
    officialName: string;
  };

  const physByName = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const officialCoords = new Map<string, string>();

  const ensurePhys = (officialName: string, coord: string): Phys => {
    const zh = guiyangStationName(officialName);
    let phys = physByName.get(zh);
    if (phys) return phys;

    const amap = amapStationIndex.get(foldGuiyangStationName(zh));
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const amapEn = String(amap?.multilang?.n?.en ?? '').trim();
    const en = ENGLISH_NAME_OVERRIDES[zh] ?? amapEn ?? pinyinToEnglish(pinyin) ?? '';
    const loc = parseSlCoord(amap?.sl);
    const pix = parsePixel(amap?.p);

    phys = {
      id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
      zh,
      en,
      pinyin,
      location: loc,
      schematic: pix,
      codes: [],
      coord,
      officialName
    };
    physByName.set(zh, phys);
    physById.set(phys.id, phys);
    officialCoords.set(phys.id, coord);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { officialId: string; cfg: ReturnType<typeof guiyangLineByOfficialId> }[] = [];

  for (const officialId of stopsByOfficialId.keys()) {
    const cfg = guiyangLineByOfficialId(officialId);
    if (!cfg) {
      throw new Error(`unknown operator line id "${officialId}" on the official station list`);
    }
    const id = guiyangLineId(cfg);
    if (lineById.has(id)) continue;

    const amap = amapLineIndex.get(cfg.name);
    const line: LineEncoded = {
      id,
      name: cfg.name,
      names: { zh: cfg.name, en: cfg.nameEn },
      aliases: [],
      color: amap?.cl ? `#${amap.cl.replace(/^#/, '').toLowerCase()}` : undefined,
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: GY_SOURCE, id: officialId },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: officialId,
        official_stop_count: stopsByOfficialId.get(officialId)?.length ?? 0,
        amap_color: amap?.cl,
        // The English label is the one printed on the operator's own network
        // map, so a Wikidata lookup must not replace it.
        names_source: 'source'
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ officialId, cfg });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const lineIdsByStation = new Map<string, Set<string>>();

  for (const { officialId, cfg } of lineCfgs) {
    if (!cfg) continue;
    const lineId = guiyangLineId(cfg);
    const officialStops = stopsByOfficialId.get(officialId) ?? [];
    const lineStops: StopEncoded[] = [];

    for (let i = 0; i < officialStops.length; i++) {
      const official = officialStops[i]!;
      const phys = ensurePhys(official.name, official.coord);

      const amap = amapStationIndex.get(foldGuiyangStationName(phys.zh));
      const code = String(amap?.si ?? '').trim();
      if (code && !phys.codes.includes(code)) phys.codes.push(code);

      const set = lineIdsByStation.get(phys.id) ?? new Set<string>();
      set.add(lineId);
      lineIdsByStation.set(phys.id, set);

      lineStops.push({
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === officialStops.length - 1,
        location: phys.location
          ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' }
          : undefined,
        schematic: phys.schematic
          ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
          : undefined,
        source_id: code || undefined,
        extras: {
          line_short_name: cfg.short,
          station_code: code || undefined,
          amap_poiid: amap?.poiid || undefined
        }
      });
    }

    if (lineStops.length < 2) continue;
    stopsByLineId.set(lineId, lineStops);

    const patternId = `${lineId}-pattern-main`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: cfg.nameEn },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: GY_SOURCE, id: officialId }],
      extras: {
        line_short_name: cfg.short,
        origin_name: lineStops[0]!.id,
        terminal_name: lineStops[lineStops.length - 1]!.id
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
        source_id: GY_SOURCE
      });
    }
  }

  // ---- Segment ride times / distances (operator planner) ---------------------
  const segmentByStationPair = new Map<string, HarvestedSegment>();
  for (const h of input.harvestedSegments ?? []) {
    const key = [h.fromName, h.toName].sort().join('|');
    if (!segmentByStationPair.has(key)) segmentByStationPair.set(key, h);
  }
  const stationNameById = new Map([...physById.values()].map((p) => [p.id, p.zh] as const));
  const withPlannerMetrics = segments.map((seg) => {
    const fromName = stationNameById.get(seg.from_station_id);
    const toName = stationNameById.get(seg.to_station_id);
    if (!fromName || !toName) return seg;
    const hit = segmentByStationPair.get([fromName, toName].sort().join('|'));
    if (!hit) return seg;
    return {
      ...seg,
      travel_time_seconds: hit.travelTimeSeconds,
      travel_time_source: 'source' as const,
      distance_km: Math.round((hit.distanceMeters / 1000) * 1000) / 1000,
      source_id: GY_PLANNER_SOURCE,
      extras: {
        ...(seg.extras ?? {}),
        distance_source: 'gyurt-planner',
        time_source: 'gyurt-planner'
      }
    };
  });
  segments.length = 0;
  segments.push(...withPlannerMetrics);

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const timetableRows = input.harvestedTimetables ?? [];

  for (const { officialId, cfg } of lineCfgs) {
    if (!cfg) continue;
    const lineId = guiyangLineId(cfg);
    const lineStops = stopsByLineId.get(lineId);
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!lineStops || !pattern) continue;

    const stopByStationName = new Map(
      lineStops.map((s) => [stationNameById.get(s.station_id) ?? '', s] as const)
    );

    for (const row of timetableRows) {
      if (row.lineId !== officialId) continue;
      const stop = stopByStationName.get(row.stationName);
      if (!stop) continue;
      // The operator names the terminal the service heads toward
      // (`窦官方向` → 窦官); that terminal is the timetable's destination.
      const target = stopByStationName.get(row.destinationName) ?? lineStops[lineStops.length - 1]!;
      if (target.id === stop.id) continue;

      const id = `${NETWORK_ID}-tt-${stop.id}-to-${target.id}`;
      if (ttIds.has(id)) continue;
      ttIds.add(id);
      timetables.push({
        id,
        station_id: stop.station_id,
        stop_id: stop.id,
        line_id: lineId,
        station_code: stop.source_id,
        source_id: GY_PLANNER_SOURCE,
        destination_stop_id: target.id,
        pattern_id: pattern.id,
        direction_type: 'linear',
        direction_label: row.direction,
        first_train: [row.first],
        last_train: [row.last],
        service: 'all_days',
        extras: {
          direction: row.direction,
          destination_name: row.destinationName,
          source_note:
            '逐站逐方向首末班取自运营方自有的路径/票价查询接口 ' +
            'cms.gyurt.com/external/interface/getSubwayLines：接口在上车站方向上返回该站的首班/末班发车时刻，' +
            '与官网首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）。'
        }
      });
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  for (const phys of physByName.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [
        { source: GY_SOURCE, id: phys.officialName },
        ...phys.codes.map((c) => ({ source: AMAP_SOURCE, id: c }) as const)
      ],
      extras: {
        pinyin: phys.pinyin,
        official_name: phys.officialName,
        official_station_codes: phys.codes.length ? phys.codes : undefined
      }
    });
  }

  // Guard against id collisions produced by romanisation.
  const idSeen = new Set<string>();
  for (const st of stations) {
    if (idSeen.has(st.id)) {
      throw new Error(`duplicate station id "${st.id}" — romanisation collision`);
    }
    idSeen.add(st.id);
  }

  const interchanges = new Map<string, string[]>(
    [...lineIdsByStation.entries()]
      .filter(([, lineIds]) => lineIds.size > 1)
      .map(([stationId, lineIds]) => [stationId, [...lineIds]] as const)
  );

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '贵阳轨道交通',
    names: { zh: '贵阳轨道交通', en: 'Guiyang Rail Transit' },
    city: placeholderCity('CN-5201'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与站序来自运营方自有的「线路，票价查询」页面 www.gyurt.com/subwayInquiry.html 的站点下拉列表：' +
      '每个 li 带 index_number（线路号）与 index_origin（该站坐标字符串），1 号线 25 站（窦官→小孟工业园）、' +
      '2 号线 32 站（白云北路→中兴路）、3 号线 29 站（洛湾→桐木岭(省委党校)）、S1 线 13 站（皂角坝→望城坡），' +
      '共 99 条 line-stop 记录、93 座物理车站、6 座换乘站（林城西路、北京路、喷水池、望城坡、延安西路、中曹司），' +
      '与官网线网图及公开资料逐站一致。首末班、区间运行时分与里程、换乘步行距离、OD 票价全部取自运营方自有的' +
      '路径规划接口 cms.gyurt.com/external/interface/getSubwayLines：该接口在上车站方向上给出该站首末班发车时刻' +
      '（与官网首末班车时刻表逐格一致，官网仅以图片发布该表，未做 OCR），逐站相邻一次查询即得该区间官方运行' +
      '时长与里程，换乘段以「站厅换乘 步行 N 米」形式公布步行距离。官方站点坐标系既非 GCJ-02 亦非 WGS-84，' +
      '实测为相对 GCJ-02 的恒定平移（北 663 m、东 649 m，合计约 983 m，扣除平移后残差中位约 32 m），' +
      '故 canonical 坐标统一取自 AMap Subway 5201（GCJ-02 原生），官方坐标字符串仅用作规划器接口的站点键。' +
      '运营方规划器库将 2 号线小碧站误记为「多彩贵州城站」（实为站旁商业综合体），以官网线网图、运营方 2025-08-29' +
      '《关于开通贵阳地铁2号线小碧站A出入口的公告》及百度地图为准更正为「小碧」。线色取自 AMap（1 号线 86B81C 绿、' +
      '2 号线 2249A3 深蓝、3 号线 FC0601 红、S1 线 A61D7F 紫），与官网线网图一致；站名英文名取自 AMap 的 multilang 字段' +
      '（即官网线网图所用英文名），其中 8 站以官网线网图措辞更正。OD 票价按运营方里程分段计价' +
      '（筑发改收费〔2017〕768 号：起步 2 元/4 公里，晋级里程 4、4、6、6、8、8，40 公里以上每加 1 元多乘 8 公里，' +
      '全网最高 11 元）结算，多路径时按最短路径计价，换乘不额外计费。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopsByLineId.values()].flat(),
    patterns,
    segments,
    timetables,
    officialCoords,
    interchanges,
    stopsByLineId,
    lineIdsByStation: new Map([...lineIdsByStation.entries()].map(([k, v]) => [k, [...v]] as const))
  };
}
