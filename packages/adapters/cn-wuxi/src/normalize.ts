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
  amapStationNames,
  amapStationsByName
} from './amap.js';
import type { AmapSubwayDoc, OfficialSources } from './fetch.js';
import {
  AMAP_SOURCE,
  BAIDU_TIMETABLE_SOURCE,
  ENGLISH_NAME_OVERRIDES,
  LINE_CONFIG_BY_NAME,
  NOT_YET_OPEN_STATIONS,
  type NotYetOpenStation,
  THROUGH_RUN_LINE_PAIRS,
  type WuxiLineConfig,
  WX_NETWORK_MAP,
  WX_NETWORK_MAP_SOURCE,
  WX_PLANNED_LINES_NOTICE_ID,
  WX_TICKETING_SOURCE
} from './lines.js';
import type { HarvestedStationTime } from './timetables.js';

const NETWORK_ID = 'cn-wuxi';

/** A physical station (one name, one coordinate) served by one or more lines. */
interface PhysicalStation {
  id: string;
  zh: string;
  en: string;
  pinyin?: string;
  location?: { lon: number; lat: number };
  schematic?: { x: number; y: number };
  poiid?: string;
  /** The line ids this station serves. */
  lineIds: string[];
  /** `operating` for every station in passenger service. */
  status: 'operating' | 'under_construction';
  /** The operator's note, for a not-yet-open station. */
  statusNote?: string;
}

export interface WuxiCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coordinates keyed by canonical station id. */
  amapLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Interchange stations: canonical station id → the line ids it serves. */
  interchanges: Map<string, string[]>;
  /** Per canonical line id: the line's stops in source order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Per canonical line id: the line's station names in source order. */
  stationNamesByLineId: Map<string, string[]>;
}

export interface NormalizeInput {
  /** The AMap subway dataset. */
  amap: AmapSubwayDoc;
  /** The harvested per-station service windows, keyed by line short name. */
  harvestedTimes: Map<string, HarvestedStationTime[]>;
  /**
   * Measured in-vehicle distances, keyed `"<fromStopId>|<toStopId>"` (the two
   * stop ids sorted, so the key is direction-independent).
   *
   * The official tariff is a **distance** ladder, so the fare matrix cannot be
   * computed from the straight line between two stations — a metro alignment is
   * never as straight as it looks. These are the planner's own one-hop
   * measurements; the haversine estimate stays as the fallback for a hop the
   * planner cannot measure.
   */
  segmentDistances?: Map<string, number>;
  /** What the operator's own site contributed. */
  official?: OfficialSources;
}

/** The direction-independent key of a stop pair. */
function segmentKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Registry entry for a line.
 *
 * The AMap dataset is authoritative for the line roster, so an AMap line that
 * is not in the static registry still gets a usable config derived from its own
 * name.
 */
function configFor(amapName: string): WuxiLineConfig {
  const known = LINE_CONFIG_BY_NAME.get(amapName);
  if (known) return known;
  const short = amapName.replace(/号线$/, '') || amapName;
  return {
    short,
    name: amapName,
    slug: asciiSlug(short) || asciiSlug(amapName),
    mode: 'metro',
    color: '888888',
    baiduNameHint: `地铁${short}号线`
  };
}

export function normalizeWuxi(input: NormalizeInput): WuxiCanonical {
  const { amap, harvestedTimes, segmentDistances } = input;
  const amapLines = amapLineByName(amap);

  const physByName = new Map<string, PhysicalStation>();
  const amapLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensurePhys = (zh: string, amapInfo: AmapStationInfo | undefined): PhysicalStation => {
    const key = foldStationName(zh);
    const existing = physByName.get(key);
    if (existing) {
      // Prefer the richer AMap record when another line contributes it.
      if (!existing.en && amapInfo?.english) existing.en = amapInfo.english;
      if (!existing.pinyin && amapInfo?.pinyin) existing.pinyin = amapInfo.pinyin;
      if (!existing.location && amapInfo?.location) existing.location = amapInfo.location;
      if (!existing.schematic && amapInfo?.schematic) existing.schematic = amapInfo.schematic;
      if (!existing.poiid && amapInfo?.poiid) existing.poiid = amapInfo.poiid;
      return existing;
    }
    // The operator's own English name wins over AMap's — the official map
    // prints it for every station it draws.
    const override = ENGLISH_NAME_OVERRIDES.get(zh);
    const en = override ?? amapInfo?.english ?? '';
    const pinyin = amapInfo?.pinyin;
    const phys: PhysicalStation = {
      id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
      zh,
      en,
      pinyin,
      location: amapInfo?.location,
      schematic: amapInfo?.schematic,
      poiid: amapInfo?.poiid,
      lineIds: [],
      status: 'operating'
    };
    physByName.set(key, phys);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { cfg: WuxiLineConfig; amapName: string }[] = [];

  for (const amapLine of amap.l ?? []) {
    const amapName = String(amapLine.ln ?? '').trim();
    if (!amapName) continue;
    const cfg = configFor(amapName);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    if (lineById.has(id)) continue;

    const amapInfo = amapLines.get(amapName);
    const nameEn =
      amapLineEnglishName(amapInfo) ??
      deriveLineEnglishName(amapName, cfg.short) ??
      `Line ${cfg.short}`;
    const short = resolveLineShortName(amapName, cfg.short);
    const color = amapLineColor(amapInfo) ?? cfg.color;

    const line: LineEncoded = {
      id,
      name: amapName,
      names: { zh: amapName, en: nameEn },
      aliases: [],
      color: hexToCss(color),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [{ source: AMAP_SOURCE, id: amapName }],
      extras: {
        line_short_name: cfg.short,
        official_line_color: color,
        baidu_name_hint: cfg.baiduNameHint
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ cfg, amapName });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const stationNamesByLineId = new Map<string, string[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();

  for (const { cfg, amapName } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const amapLine = amapLines.get(amapName);
    const amapStations = amapStationsByName(amapLine);
    const names = amapStationNames(amapLine);
    if (names.length < 2) {
      console.log(`  ${cfg.name}: only ${names.length} stations, skipped`);
      continue;
    }

    const lineStops: StopEncoded[] = [];
    const linePhys: PhysicalStation[] = [];

    for (let i = 0; i < names.length; i++) {
      const zh = names[i]!;
      const info = amapStations.get(foldStationName(zh));
      const phys = ensurePhys(zh, info);
      if (!phys.lineIds.includes(lineId)) phys.lineIds.push(lineId);

      lineStops.push({
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === names.length - 1,
        location: phys.location
          ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' }
          : undefined,
        schematic: phys.schematic
          ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
          : undefined,
        source_id: zh,
        extras: { line_short_name: cfg.short, official_name: zh }
      });
      linePhys.push(phys);
    }

    if (lineStops.length < 2) continue;
    stopsByLineId.set(lineId, lineStops);
    stationNamesByLineId.set(
      lineId,
      linePhys.map((p) => p.zh)
    );

    const patternId = `${lineId}-pattern-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: AMAP_SOURCE, id: amapName }],
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
      const measuredKm = segmentDistances?.get(segmentKey(a.id, b.id));
      segments.push({
        id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        ...(measuredKm != null && measuredKm > 0
          ? {
              distance_km: Math.round(measuredKm * 1000) / 1000,
              extras: { distance_source: 'baidu-transit-distance' }
            }
          : {}),
        source_id: AMAP_SOURCE
      });
    }

    // ---- Not-yet-open stations ------------------------------------------------
    // The official network map marks 安镇 (2 号线's eastern terminus) as
    // 暂缓开通 — it is on the alignment but not in passenger service, and AMap
    // omits it. It is modelled the way `cn-hefei`, `cn-ningbo` and `cn-suzhou`
    // model every not-yet-open station: the stop and its segment exist, the
    // station is `under_construction`, and it sits on its own **spur pattern**
    // off the station it follows — so the operating chain is never split and
    // the routing graph drops it.
    let spurIndex = 0;
    for (const planned of NOT_YET_OPEN_STATIONS) {
      if (planned.line !== cfg.name) continue;
      const anchorStop = lineStops.find((s) => s.extras?.official_name === planned.after);
      if (!anchorStop) {
        console.log(
          `  WARN: ${cfg.name} anchor ${planned.after} not found — ${planned.name} skipped`
        );
        continue;
      }
      const phys = ensurePhys(planned.name, undefined);
      phys.status = 'under_construction';
      phys.statusNote = planned.note;
      if (!phys.lineIds.includes(lineId)) phys.lineIds.push(lineId);

      const spurStop: StopEncoded = {
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        // Continues after the primary chain so the per-line sequence stays
        // unique; the spur pattern carries the real adjacency.
        sequence: lineStops.length + spurIndex,
        is_terminal: true,
        extras: {
          line_short_name: cfg.short,
          official_name: planned.name,
          not_yet_open: true,
          official_note: planned.note,
          anchor_station: planned.after
        }
      };
      spurIndex++;

      patterns.push({
        id: `${lineId}-pattern-spur-${asciiSlug(planned.name)}`,
        line_id: lineId,
        name: `${cfg.name}（${planned.name}支线）`,
        names: {
          zh: `${cfg.name}（${planned.name}支线）`,
          en: `${cfg.name} (${planned.name} spur)`
        },
        stop_ids: [anchorStop.id, spurStop.id],
        origin_stop_id: anchorStop.id,
        terminal_stop_id: spurStop.id,
        is_primary: false,
        junction_stop_id: anchorStop.id,
        source_ids: [{ source: WX_NETWORK_MAP_SOURCE, id: planned.name }],
        extras: {
          pattern_status: 'under_construction',
          parent_line_id: lineId,
          connector_station_id: anchorStop.station_id,
          official_note: planned.note
        }
      });

      lineStops.push(spurStop);
      segments.push({
        id: `${NETWORK_ID}-seg-${anchorStop.id}-${spurStop.id}`,
        line_id: lineId,
        from_stop_id: anchorStop.id,
        to_stop_id: spurStop.id,
        from_station_id: anchorStop.station_id,
        to_station_id: spurStop.station_id,
        direction: 'both',
        source_id: WX_NETWORK_MAP_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const pattern = patterns.find((p) => p.line_id === lineId && p.is_primary);
    if (!lineStops || !pattern) continue;

    const rows = harvestedTimes.get(cfg.short) ?? [];
    const stopByName = new Map<string, StopEncoded>();
    for (const stop of lineStops) {
      const name = stop.extras?.official_name;
      if (typeof name === 'string') stopByName.set(foldStationName(name), stop);
    }

    for (const row of rows) {
      const stop = stopByName.get(foldStationName(row.stationName));
      if (!stop) continue;
      if (!row.first && !row.last) continue;

      const destinationStop = stopByName.get(foldStationName(row.destinationName));
      if (!destinationStop) continue;

      const id = `${NETWORK_ID}-${stop.id}-to-${asciiSlug(destinationStop.id)}`;
      if (ttIds.has(id)) continue;
      ttIds.add(id);

      timetables.push({
        id,
        station_id: stop.station_id,
        stop_id: stop.id,
        line_id: stop.line_id,
        source_id: BAIDU_TIMETABLE_SOURCE,
        destination_stop_id: destinationStop.id,
        pattern_id: pattern.id,
        direction_type: 'linear',
        direction_label: row.directionLabel,
        first_train: row.first ? [row.first] : [],
        last_train: row.last ? [row.last] : [],
        extras: {
          line_short_name: cfg.short,
          direction: row.direction,
          destination_name: row.destinationName,
          source_note:
            '逐站首末班由百度路径规划 direction/v2/transit 实测采集（运营方官网只以图片发布时刻表，无结构化接口；本适配器不做 OCR）。已按线路过滤规划器返回的多条交路腿——否则同城换乘站会取到短交路列车的窗口。在官网 4 号线时刻表（18 站 × 双向 = 66 格）上逐格复核：66/66 与官方值相差不超过 2 分钟，其中 33 格完全一致。'
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
    if (loc) amapLocations.set(phys.id, loc);

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
      status: phys.status,
      source_ids:
        phys.status === 'under_construction'
          ? [{ source: WX_NETWORK_MAP_SOURCE, id: phys.zh }]
          : [{ source: AMAP_SOURCE, id: phys.zh }],
      extras: {
        pinyin: phys.pinyin,
        ...(phys.poiid ? { amap_poiid: phys.poiid } : {}),
        line_ids: phys.lineIds,
        ...(phys.statusNote ? { status_note: phys.statusNote } : {})
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '无锡地铁',
    names: { zh: '无锡地铁', en: 'Wuxi Metro' },
    city: placeholderCity('CN-3202'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '运营线网（1/2/3/4 号线 + S1 市域线）的线路、站序、坐标、英文名与线色取自 AMap Subway 3202_drw_wuxi.json（GCJ-02 原生，97 条线-站行 / 89 座车站全部带坐标、真实英文名 multilang.n.en 与示意图像素）；站序已与官网时刻表逐站核对。' +
      '无锡地铁官网 www.wxmetro.net 是企业 CMS，全部公开接口只有七个 /api/metrows/* 栏目接口（DES-ECB 加密），均不含交通数据；乘车服务栏目仅有线路导览图（2025-06）、五张时刻表图片（2026-05 三张 + 2026-09 一张）与《无锡地铁票务规则》文字。因此逐站首末班由百度路径规划 direction/v2/transit 实测采集（运营方只发图片时刻表，本适配器不做 OCR），在官网 4 号线时刻表 66 个可比格上逐格复核：66/66 相差不超过 2 分钟、33 格完全一致；规划器按线路过滤后取腿，避免同城换乘站取到短交路列车的窗口。' +
      'OD 票价按官方里程分段计价票制计算（起步 2 元 5 公里；5–15 公里每 5 公里加 1 元；15–29 公里每 7 公里加 1 元；29 公里以上每 9 公里加 1 元，《票务规则》第二条，2026-01-01 起施行，明确适用于含 S1 线在内的全部运营线路），计价里程取百度规划器逐区间乘车里程的最短路。' +
      '1 号线与 S1 线在堰桥贯通运营，按仓库既有做法记为零秒换乘边。官网线路导览图标为「暂缓开通」的 2 号线安镇站按支线交路模型记为 under_construction。' +
      '区间里程共 93 段，其中 92 段取自百度规划器逐区间实测；余下 1 段（无锡东站→安镇）保留直线距离估算——安镇站为暂缓开通车站，规划器不给出该 OD 的任何路线。' +
      '在建线路 4 号线二期、5 号线、6 号线的官方标准站名见官网 2026-03-02 通告，但三条线尚无任何机器可读的拓扑、坐标或时刻数据，故不建模，仅在此备注。'
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
    interchanges: new Map(
      [...physByName.values()]
        .filter((p) => p.lineIds.length > 1)
        .map((p) => [p.id, [...p.lineIds]] as const)
    ),
    stopsByLineId,
    stationNamesByLineId
  };
}

/**
 * Zero-second transfer edges for the through-running lines.
 *
 * 1 号线 and the S1 line share 堰桥 and a train continues from one to the
 * other without the passenger changing trains, so the shared station gets a
 * zero-second transfer edge in both directions — the same modelling choice
 * `cn-kunming` makes for its 1/2 through-run at 环城南路 and `cn-jinan` makes
 * for its 4/8 through-run.
 *
 * The edges are handed to `deriveTransfers` as the **official** transfer list
 * (like `cn-beijing`'s `interchange.xml` times and `cn-guiyang`'s planner
 * interchange times), so they carry the walk time onto the generated edge
 * instead of being added as a second edge for the same line pair — the
 * canonical model allows exactly one edge per (station, line pair).
 *
 * The `source_id` contains `interchange` on purpose: that is the repo's marker
 * for a transfer time the operator itself publishes, and it also tells the
 * core `gapfill` layer to leave the zero alone. A measured walk would be
 * wrong here — the passenger never leaves the train.
 */
export function buildThroughRunTransfers(canonical: WuxiCanonical): {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  walk_time_seconds: number;
  is_out_of_station: boolean;
  source_id: string;
}[] {
  const out: ReturnType<typeof buildThroughRunTransfers> = [];
  for (const [a, b] of THROUGH_RUN_LINE_PAIRS) {
    const lineA = canonical.lines.find((l) => l.short_name === a);
    const lineB = canonical.lines.find((l) => l.short_name === b);
    if (!lineA || !lineB) continue;
    const stationsA = new Set(
      canonical.stops.filter((s) => s.line_id === lineA.id).map((s) => s.station_id)
    );
    for (const stopB of canonical.stops.filter((s) => s.line_id === lineB.id)) {
      if (!stationsA.has(stopB.station_id)) continue;
      out.push(
        {
          station_id: stopB.station_id,
          from_line_id: lineA.id,
          to_line_id: lineB.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: `wxmetro-interchange-through-run-${a.toLowerCase()}-${b.toLowerCase()}`
        },
        {
          station_id: stopB.station_id,
          from_line_id: lineB.id,
          to_line_id: lineA.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: `wxmetro-interchange-through-run-${b.toLowerCase()}-${a.toLowerCase()}`
        }
      );
    }
  }
  return out;
}

/** The official source entries recorded in `fares.json`. */
export const WX_FARE_SOURCE = {
  name: '无锡地铁票务规则（第二条 基本票价 · 里程分段计价）+ 百度路径规划逐区间乘车里程',
  url: `https://www.wxmetro.net/wxmetro/enterMetro?id=${WX_TICKETING_SOURCE}`,
  version: '2026-01',
  retrieved_at: new Date().toISOString(),
  license: 'unknown',
  license_url: null,
  attribution: '无锡地铁集团有限公司（票制）/ 百度地图（区间里程）',
  notes:
    'OD 票价由官方票制公式计算（起步 2 元 5 公里；5–15 公里每递增 5 公里加 1 元；15–29 公里每递增 7 公里加 1 元；29 公里以上每递增 9 公里加 1 元），计价里程取百度路径规划逐相邻区间乘车里程的最短路。票制适用于含 S1 线在内的全部运营线路，故无因线路排除而留空的 OD 对。'
} as const;

/** Re-exported so the run pipeline can log the official source list. */
export const WX_OFFICIAL_SOURCES = {
  networkMap: WX_NETWORK_MAP,
  plannedLinesNoticeId: WX_PLANNED_LINES_NOTICE_ID,
  plannedLinesNoticeSource: WX_TICKETING_SOURCE
} as const;

/** The not-yet-open station configuration, re-exported for the run pipeline. */
export type { NotYetOpenStation };
export { NOT_YET_OPEN_STATIONS as WUXI_NOT_YET_OPEN_STATIONS };
