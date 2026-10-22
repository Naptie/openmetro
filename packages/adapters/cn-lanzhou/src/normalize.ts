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
import type {
  AmapLine,
  AmapStation,
  AmapSubwayDoc,
  LanzhouSources,
  OfficialLineEntry
} from './fetch.js';
import { LANZHOU_LINES, type LanzhouLineConfig } from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-lanzhou';
const LZ_SOURCE = 'lzgdjt-serve-js';
const AMAP_SOURCE = 'amap-subway-6201';

export interface LanzhouCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /**
   * AMap GCJ-02 coordinates keyed by canonical station id.
   *
   * The operator publishes no coordinates at all, so these are **not**
   * official locations — they are the AMap Subway dataset, used as a
   * cross-check for the geocoding cascade.
   */
  amapLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Interchange stations: canonical station id → the line ids it serves. */
  interchanges: Map<string, string[]>;
  /** Per canonical line id: the line's stops in official line order. */
  stopsByLineId: Map<string, StopEncoded[]>;
}

/**
 * Fold a station name for matching between the operator's literal, the
 * operator's fare matrix, the operator's timetable sheets and AMap.
 *
 * The four sources spell one station differently: the network literal and the
 * fare matrix use `兰州城市学院`, while the timetable sheets and AMap use
 * `兰州城市学院(省科技馆)`. A bracketed part is an alias, so it is dropped.
 * A trailing 站 is also dropped, which the operator's sheets append
 * (`东方红广场站`) and the planner keeps (`东方红广场站(A口)`).
 */
export function foldLanzhouStationName(name: string): string {
  return name
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .replace(/站$/, '')
    .trim();
}

/** The bracketed alias of a station name, if it has one. */
export function stationAlias(name: string): string | undefined {
  const m = /[(（]([^)）]+)[)）]/.exec(name);
  return m?.[1]?.trim() || undefined;
}

/** Drop the bracketed alias from a pinyin string (`… XueYuan (Sheng KeJiGuan)`). */
function stripAliasFromPinyin(pinyin: string): string {
  return pinyin
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
      const key = foldLanzhouStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

/**
 * Registry entry for an official line.
 *
 * The operator's literal is authoritative for the name and the stops; the
 * registry only adds the canonical id slug and the planner's vehicle-name
 * fragment. An unknown official line still gets a usable config.
 */
function configFor(
  official: OfficialLineEntry,
  byOfficialId: Map<string, LanzhouLineConfig>
): LanzhouLineConfig {
  const known = byOfficialId.get(official.value);
  if (known) return known;
  const short = official.title.replace(/号线$/, '') || official.value;
  return {
    officialId: official.value,
    short,
    name: official.title,
    slug: short.replace(/[^A-Za-z0-9]+/g, '') || official.value,
    mode: 'metro',
    baiduNameHint: `轨道交通${short}号线`
  };
}

export interface NormalizeInput {
  sources: LanzhouSources;
  /** Per official line id: the harvested per-station first/last trains. */
  harvestedTimes?: Map<string, HarvestedStationTimes[]>;
}

export function normalizeLanzhou(input: NormalizeInput): LanzhouCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);
  const cfgByOfficialId = new Map(LANZHOU_LINES.map((c) => [c.officialId, c] as const));

  type Phys = {
    id: string;
    zh: string;
    en: string;
    pinyin?: string;
    alias?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    /** AMap per-line station codes this station carries. */
    codes: string[];
  };

  const physByFold = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const amapLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensurePhys = (officialName: string): Phys => {
    const zh = officialName.trim();
    const key = foldLanzhouStationName(zh);
    let phys = physByFold.get(key);
    if (phys) return phys;

    const amap = amapStationIndex.get(key);
    const pinyinRaw = String(amap?.sp ?? '').trim();
    const pinyin = pinyinRaw ? stripAliasFromPinyin(pinyinRaw) : undefined;
    const en = pinyinToEnglish(pinyin) ?? '';
    const loc = parseSlCoord(amap?.sl);
    const pix = parsePixel(amap?.p);

    phys = {
      id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
      zh,
      en,
      pinyin,
      alias: stationAlias(zh) ?? (amap ? stationAlias(String(amap.n ?? '')) : undefined),
      location: loc,
      schematic: pix,
      codes: []
    };
    physByFold.set(key, phys);
    physById.set(phys.id, phys);
    if (loc) amapLocations.set(phys.id, { ...loc, crs: 'gcj02' });
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { official: OfficialLineEntry; cfg: LanzhouLineConfig }[] = [];

  for (const official of sources.officialLines) {
    const cfg = configFor(official, cfgByOfficialId);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    if (lineById.has(id)) continue;

    const amap = amapLineIndex.get(cfg.name) ?? amapLineIndex.get(`${cfg.short}号线`);
    const nameEn = String(amap?.multilang?.ln?.en ?? '').trim() || `Line ${cfg.short}`;
    const line: LineEncoded = {
      id,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: [],
      color: amap?.cl ? `#${amap.cl.replace(/^#/, '').toLowerCase()}` : undefined,
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: LZ_SOURCE, id: official.value },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.value,
        official_stop_count: official.lines.length,
        amap_color: amap?.cl,
        baidu_name_hint: cfg.baiduNameHint
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ official, cfg });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const lineIdsByStation = new Map<string, Set<string>>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops: StopEncoded[] = [];
    const lineStationIds: string[] = [];

    // The operator's literal lists the stops in line order; that order is
    // authoritative. (AMap publishes Line 2 in the opposite order, so only
    // per-station attributes are taken from AMap, never the sequence.)
    for (let i = 0; i < official.lines.length; i++) {
      const officialName = official.lines[i]!;
      const phys = ensurePhys(officialName);
      const amap = amapStationIndex.get(foldLanzhouStationName(officialName));
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
        is_terminal: i === 0 || i === official.lines.length - 1,
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
      lineStationIds.push(phys.id);
    }

    if (lineStops.length < 2) continue;
    stopsByLineId.set(lineId, lineStops);

    const patternId = `${lineId}-pattern-main`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: LZ_SOURCE, id: official.value }],
      extras: {
        line_short_name: cfg.short,
        origin_name: official.lines[0],
        terminal_name: official.lines[official.lines.length - 1]
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
        source_id: LZ_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const rows = input.harvestedTimes?.get(official.value);
    if (!lineStops || !rows) continue;

    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!pattern) continue;

    const rowByName = new Map(rows.map((r) => [foldLanzhouStationName(r.stationName), r] as const));
    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;

    for (const stop of lineStops) {
      const station = physById.get(stop.station_id);
      if (!station) continue;
      const row = rowByName.get(foldLanzhouStationName(station.zh));
      if (!row) continue;

      const directions: {
        first?: string | null;
        last?: string | null;
        label?: string | null;
        destStop: StopEncoded;
      }[] = [
        { first: row.downFirst, last: row.downLast, label: row.downDirection, destStop: lastStop },
        { first: row.upFirst, last: row.upLast, label: row.upDirection, destStop: firstStop }
      ];

      for (const dir of directions) {
        if (!dir.first || !dir.last) continue;
        const id = `${NETWORK_ID}-tt-${stop.id}-to-${dir.destStop.id}`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        const destStation = physById.get(dir.destStop.station_id);
        timetables.push({
          id,
          station_id: stop.station_id,
          stop_id: stop.id,
          line_id: lineId,
          station_code: stop.source_id,
          source_id: 'baidu-transit-direction',
          destination_stop_id: dir.destStop.id,
          pattern_id: pattern.id,
          direction_type: 'linear',
          direction_label: dir.label ?? undefined,
          first_train: [dir.first],
          last_train: [dir.last],
          service: 'all_days',
          extras: {
            direction: dir.label,
            destination_name: destStation?.zh,
            source_note:
              '逐站首末班取自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：detail.first_time / detail.last_time 为该方向上车站自身的首班/末班发车时刻，与官网公布的首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）。'
          }
        });
      }
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  for (const phys of physByFold.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (loc) amapLocations.set(phys.id, loc);
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
        { source: LZ_SOURCE, id: phys.zh },
        ...phys.codes.map((c) => ({ source: AMAP_SOURCE, id: c }) as const)
      ],
      extras: {
        pinyin: phys.pinyin,
        alias: phys.alias,
        official_station_codes: phys.codes.length ? phys.codes : undefined
      }
    });
  }

  const interchanges = new Map<string, string[]>(
    [...lineIdsByStation.entries()]
      .filter(([, lineIds]) => lineIds.size > 1)
      .map(([stationId, lineIds]) => [stationId, [...lineIds]] as const)
  );

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '兰州轨道交通',
    names: { zh: '兰州轨道交通', en: 'Lanzhou Rail Transit' },
    city: placeholderCity('CN-6201'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与站序来自官网 www.lzgdjt.com 生产环境静态资产 /lzgd/template/js/serve.js 的 const lines 字面量：1 号线 20 站（陈官营→东岗）、2 号线 9 站（东方红广场→雁白大桥），共 29 条 line-stop 记录、27 座物理车站、2 座换乘站（东方红广场同台换乘、五里铺节点换乘，换乘判定与官网 fareUtil.js 的客户端路由逻辑一致）。OD 票价来自官网静态资产 /lzgd/template/js/fareData.js 的 window.fareData 矩阵：27 起点 × 26 终点 = 702 个单元，对称、无缺值，取值 2–7 元；官网线上「票价查询」由 fareUtil.js 覆写 webPost.getRoute 后完全在客户端读取同一份矩阵，故该矩阵即运营方现行票价源，与官网公布的里程分段计价（起步 2 元/4 公里，晋级里程 4、4、6、6、8、8，40 公里以上每加 1 元多乘 8 公里）逐带吻合。官网后端不可用且不予依赖：/user-service/web/getLineStation 与 getStationInfo 超时，/tb/* 全部返回 502「网站正在维护中」页。坐标、示意图像素、线内站码、拼音与线色来自 AMap Subway 6201（GCJ-02 原生；AMap 2 号线站序与官网相反，故站序以官网为准；AMap 将 兰州城市学院 记作 兰州城市学院(省科技馆)，括注为别称）。站名英文名由 AMap 拼音罗马化得出：官网与 AMap 均无英文站名，Wikidata 对 22/27 站仅返回通用标签 Station、且 奥体中心 命中同名重庆站点，故不以 Wikidata 为主源。逐站逐方向首末班来自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：该接口给出上车站自身的首班/末班发车时刻，与官网首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）；较早的 directionlite/v1/transit 不支持该偏好参数，对部分起点会返回「步行至邻站再上车」的路线而无轨道段，故不以它为主源。百度会为换乘站返回含换乘的多条线路，必须按上车站匹配并优先取方向标签指向该方向终点的区间，否则 2 号线东方红广场会取到换乘方案的 23:14 而非官网的 23:03。官网时刻表在两端终点站另给出对向到达时刻，canonical 模型不表达到达类条目。工作日/双休日的逐站差异不存在于任何机读源，故时刻表层只发布单一变体。在建的 3/4/5/6/7 号线无结构化站表，未建模。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopsByLineId.values()].flat(),
    patterns,
    segments,
    timetables,
    amapLocations,
    interchanges,
    stopsByLineId
  };
}
