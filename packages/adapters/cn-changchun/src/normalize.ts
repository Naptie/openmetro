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
  pinyinToEnglish,
  placeholderCity,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded,
  titleCaseRoman
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, CcLine, ChangchunSources } from './fetch.js';
import { parseOfficialCoord } from './fetch.js';
import { type ChangchunLineConfig, LINE_CONFIG_BY_OFFICIAL_CODE } from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-changchun';
const OFFICIAL_SOURCE = 'ccqg-getLines';
const AMAP_SOURCE = 'amap-subway-2201';

export interface ChangchunCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** Official GCJ-02 coordinates keyed by canonical station id. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Interchange stations: canonical station id → the line ids it serves. */
  interchanges: Map<string, string[]>;
  /** Per canonical line id: the line's stops in line order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Per canonical line id: the line's station names in line order. */
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

function amapStationByName(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byName = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, st);
    }
  }
  return byName;
}

/**
 * Normalise AMap's English station name.
 *
 * AMap mixes conventions for the same network — `North Ring Rd.`,
 * `QINGFENG Rd.`, `JIEFANG Ave.`, `ChangChun Railway Station North` — so a
 * fully upper-case name is title-cased while anything already mixed-case is
 * kept as published.
 */
export function normalizeEnglishName(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (!letters) return undefined;
  if (letters === letters.toUpperCase()) return titleCaseRoman(t);
  return t;
}

/**
 * Registry entry for an official line.
 *
 * The official feed is authoritative; the static registry only supplies the
 * canonical id slug, the service mode and the planner's vehicle-name
 * fragment. An unknown official line still gets a usable config.
 */
function configFor(official: CcLine): ChangchunLineConfig {
  const known = LINE_CONFIG_BY_OFFICIAL_CODE.get(official.linecode);
  if (known) return known;
  const name = official.cname.trim();
  const short = name.replace(/号线$/, '') || official.linecode;
  return {
    short,
    name,
    slug: asciiSlug(short) || official.linecode,
    mode: 'metro',
    baiduNameHint: `轨道交通${short}号线`
  };
}

export interface NormalizeInput {
  sources: ChangchunSources;
  /** Per official line code: the harvested per-station first/last trains. */
  harvestedTimes?: Map<string, HarvestedStationTimes[]>;
}

export function normalizeChangchun(input: NormalizeInput): ChangchunCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByName(sources.amap);

  type Phys = {
    id: string;
    zh: string;
    en: string;
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    amapPoiId?: string;
    /** Official per-line GCJ-02 coordinates, keyed by line name. */
    officialLocations: Map<string, { lon: number; lat: number }>;
    /** Official stop codes per line, keyed by line name. */
    stopCodes: Map<string, string>;
  };

  const physByName = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const usedIds = new Set<string>();

  /** A stable, unique station id from the English name (or pinyin). */
  const stationId = (en: string, zh: string, pinyin?: string): string => {
    const base = `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`;
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let n = 2;
    while (usedIds.has(`${base}-${n}`)) n++;
    usedIds.add(`${base}-${n}`);
    return `${base}-${n}`;
  };

  const ensurePhys = (zh: string): Phys | undefined => {
    const name = zh.trim();
    if (!name) return undefined;
    const key = foldStationName(name);
    const existing = physByName.get(key);
    if (existing) return existing;

    const amap = amapStationIndex.get(name);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const en = normalizeEnglishName(amap?.multilang?.n?.en) ?? pinyinToEnglish(pinyin) ?? '';
    const loc = parseSlCoord(amap?.sl);
    const pix = parsePixel(amap?.p);
    const phys: Phys = {
      id: stationId(en, name, pinyin),
      zh: name,
      en,
      pinyin,
      location: loc,
      schematic: pix,
      amapPoiId: amap?.poiid,
      officialLocations: new Map(),
      stopCodes: new Map()
    };
    physByName.set(key, phys);
    physById.set(phys.id, phys);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { code: string; cfg: ChangchunLineConfig }[] = [];

  const officialLines = [...sources.lines].sort((a, b) => (a.indexno ?? 0) - (b.indexno ?? 0));
  for (const official of officialLines) {
    const cfg = configFor(official);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    const amap = amapLineIndex.get(official.cname);
    const nameEn = deriveLineEnglishName(official.cname) ?? `Line ${cfg.short}`;
    const line: LineEncoded = {
      id,
      name: official.cname,
      names: { zh: official.cname, en: nameEn },
      aliases: [],
      color: hexToCss(amap?.cl),
      short_name: resolveLineShortName(official.cname, cfg.short),
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: OFFICIAL_SOURCE, id: official.linecode },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        names_source: 'source',
        official_line_code: official.linecode,
        official_line_colour_code: official.linecolour,
        amap_color: amap?.cl,
        baidu_vehicle_name: cfg.baiduNameHint
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ code: official.linecode, cfg });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const stationNamesByLineId = new Map<string, string[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const interchangeLines = new Map<string, Set<string>>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  for (const { code, cfg } of lineCfgs) {
    const official = sources.lines.find((l) => l.linecode === code);
    if (!official) continue;
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const officialStops = official.standList;
    if (officialStops.length < 2) {
      console.log(`  ${cfg.name}: only ${officialStops.length} stops, skipped`);
      continue;
    }

    const lineStops: StopEncoded[] = [];
    const linePhys: Phys[] = [];

    // The array order of the official response is the line order.
    for (let i = 0; i < officialStops.length; i++) {
      const stop = officialStops[i]!;
      const phys = ensurePhys(stop.cname);
      if (!phys) continue;

      // The official per-line coordinate is a platform-level point: the same
      // physical station is up to 200 m apart between two lines. It belongs to
      // the stop, while the station itself keeps the AMap station centroid.
      const stopLon = parseOfficialCoord(stop.longitude);
      const stopLat = parseOfficialCoord(stop.latitude);
      if (stopLon != null && stopLat != null) {
        phys.officialLocations.set(cfg.name, { lon: stopLon, lat: stopLat });
      }
      phys.stopCodes.set(cfg.name, stop.standcode);

      // The official `transferinfo` names the official stop code of the same
      // physical station on the other line — the operator publishes the
      // interchange map itself, and it is reciprocal on every one of the 26
      // interchanges. It is empty in **both** directions for 东大桥 (4号线/5
      // 号线), so the interchange set is derived from the stop topology (a
      // station served by two or more lines) and the official code is kept as
      // corroboration.
      {
        const set = interchangeLines.get(phys.id) ?? new Set<string>();
        set.add(lineId);
        interchangeLines.set(phys.id, set);
      }

      lineStops.push({
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === officialStops.length - 1,
        location:
          stopLon != null && stopLat != null
            ? { lon: stopLon, lat: stopLat, crs: 'gcj02' }
            : undefined,
        schematic: phys.schematic
          ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
          : undefined,
        source_id: stop.standcode,
        extras: {
          line_short_name: cfg.short,
          official_stop_code: stop.standcode,
          official_station_id: stop.id,
          official_gaodeid: stop.gaodeid,
          official_transfer_code: stop.transferinfo || undefined
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

    const originName = linePhys[0]?.zh ?? '';
    const terminalName = linePhys[linePhys.length - 1]?.zh ?? '';
    const patternId = `${NETWORK_ID}-pattern-${cfg.short}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${originName} → ${terminalName}`,
      names: {
        zh: `${originName}→${terminalName}`,
        en: `${originName} to ${terminalName}`
      },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: OFFICIAL_SOURCE, id: code }],
      extras: {
        line_short_name: cfg.short,
        origin_name: originName,
        terminal_name: terminalName
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
        source_id: OFFICIAL_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  //
  // The planner is the primary source (it matches the operator's published
  // sheets on every probed pair, on every line). The official feed fills the
  // gaps and is kept next to the published value so the disagreement on line 1
  // stays visible in the data.
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { code, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const official = sources.lines.find((l) => l.linecode === code);
    const rows = input.harvestedTimes?.get(code);
    if (!lineStops || !official || !rows) continue;
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!pattern) continue;

    const rowByName = new Map(rows.map((r) => [r.stationName.trim(), r] as const));
    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;

    for (let i = 0; i < lineStops.length; i++) {
      const stop = lineStops[i]!;
      const station = physById.get(stop.station_id);
      if (!station) continue;
      const row = rowByName.get(station.zh.trim());
      const officialStop = official.standList[i];
      if (!row || !officialStop) continue;

      // `up` heads towards `standList[0]`, `down` towards `standList[last]`.
      const directions: {
        first?: string | null;
        last?: string | null;
        label?: string | null;
        destStop: StopEncoded;
        officialFirst?: string;
        officialLast?: string;
      }[] = [
        {
          first: row.downFirst,
          last: row.downLast,
          label: row.downDirection,
          destStop: lastStop,
          officialFirst: officialStop.downfirstdate,
          officialLast: officialStop.downlastdate
        },
        {
          first: row.upFirst,
          last: row.upLast,
          label: row.upDirection,
          destStop: firstStop,
          officialFirst: officialStop.upfirstdate,
          officialLast: officialStop.uplastdate
        }
      ];

      for (const dir of directions) {
        const first = dir.first ?? normTime(dir.officialFirst);
        const last = dir.last ?? normTime(dir.officialLast);
        if (!first || !last) continue;
        const source = dir.first && dir.last ? 'baidu-transit-direction' : OFFICIAL_SOURCE;
        const id = `${NETWORK_ID}-${stop.station_id}-${cfg.short}-to-${asciiSlug(
          dir.destStop.station_id
        )}-primary`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        const destStation = physById.get(dir.destStop.station_id);
        const differs =
          (dir.officialFirst && normTime(dir.officialFirst) !== first) ||
          (dir.officialLast && normTime(dir.officialLast) !== last);
        timetables.push({
          id,
          station_id: stop.station_id,
          stop_id: stop.id,
          line_id: lineId,
          station_code: stop.source_id,
          source_id: source,
          destination_stop_id: dir.destStop.id,
          pattern_id: pattern.id,
          direction_type: 'linear',
          direction_label: dir.label ?? undefined,
          first_train: [first],
          last_train: [last],
          extras: {
            service: 'primary',
            direction: dir.label,
            destination_name: destStation?.zh,
            official_first_train: normTime(dir.officialFirst),
            official_last_train: normTime(dir.officialLast),
            disagrees_with_official: differs || undefined,
            source_note:
              '逐站首末班取自百度路径规划 direction/v2/transit 的 detail.first_time/last_time（该方向上车站自身的首/末班发车时刻），与官网逐线首末班时刻表（/1hx4…/8hx4）逐项吻合；官网仅以图片发布该表，未做 OCR。官网接口 /api/v1/getLines 亦给出逐站首末班，作为缺口的兜底并在此记录差异——1 号线的官网数据陈旧（下行首班早 10 分钟、上行末班晚 12–14 分钟），以规划器为准。'
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
      source_ids: [
        { source: OFFICIAL_SOURCE, id: phys.zh },
        ...(phys.amapPoiId ? [{ source: AMAP_SOURCE, id: phys.amapPoiId }] : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        amap_poiid: phys.amapPoiId,
        official_stop_codes: Object.fromEntries(phys.stopCodes),
        official_locations: Object.fromEntries(
          [...phys.officialLocations.entries()].map(([line, loc2]) => [
            line,
            { lon: loc2.lon, lat: loc2.lat }
          ])
        ),
        names_source: phys.en ? 'source' : undefined
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '长春轨道交通',
    names: { zh: '长春轨道交通', en: 'Changchun Rail Transit' },
    city: placeholderCity('CN-2201'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 900 },
    notes:
      '拓扑/站序/官方线内站码/换乘关系来自官网 www.ccqg.com 的 POST /api/v1/getLines（官网乘车查询页自身调用的接口）：168 条 line-stop 记录、142 个唯一车站、26 座换乘站，换乘码由官方 transferinfo 给出且完全互指（唯独东大桥 4/5 号线双向为空，故换乘集合按「一个车站被 ≥2 条线服务」的拓扑推导，官方码仅作佐证）。8 条线（1–8）全部在运营，5 号线 2026-09-28 开通、6 号线 2026-03-28 开通。官网接口的行级字段陈旧不可用（2/3/4 号线的 standnumber 与实际站数不符，4 号线 endstand 仍写作已废弃的「车场站」，行级首末班窗口在 7/8 号线上完全相同，linecolour 只是序号而非色值），adapter 只采信 standList；5 号线全部坐标带一个全角右单引号，需剥离后解析。坐标与英文名来自 AMap Subway 2201（142 站名与官网完全一致），官方逐线站台坐标落在 stop.location 上。逐站逐方向首末班来自百度路径规划 direction/v2/transit 的 detail.first_time/last_time（该方向上车站自身的发车时刻），与官网逐线时刻表图片逐项吻合；官网仅以图片发布时刻表，未做 OCR。官网接口自身给出的逐站首末班与百度在 2–8 号线上一致、在 1 号线上陈旧（下行首班早 10 分钟、上行末班晚 12–14 分钟），因此以百度为准、官网仅作兜底并记录差异。冬季（11 月 1 日–次年 4 月 30 日）与工作日/双休日的逐站差异只存在于官网图片中，机器可读源无法区分，故时刻表层只发布单一变体。区间时间与车厢内里程均取自百度规划器（逐相邻站对采集，160/160 命中），换乘步行按「离枢纽最近的站厅步行段」测得全部 26 座换乘站；其中 10 座站用的是规划器的同一组建模值（站厅换乘 231 米 / 193 秒），并非逐站实测。OD 票价按官网公布的里程分段计价（7 公里以内 2 元，其后每 6、6、8、8 公里加 1 元，35 公里以上每增加 10 公里加 1 元，按起点至终点最短路径核算）由 segments.distance_km 上的最短轨道里程确定性计算——官网票价接口 /api/v1/getTicketFee 对任何参数形式都返回空结果，故不采用。计费里程比规划器实测的车厢内里程多 103–312 m（运营方按停靠点间距计费，规划器按站点参考点测距），矩阵取中值 200 m 补偿。矩阵按运营方公布的「最短路径」口径取全网最短轨道里程，因此个别 OD 与规划器报价不同：汽车公园→雾开河大街的 2 号线直达为 34.94 km（规划器报价 7 元），而全网最短路径是 7 号线→3 号线→2 号线的 33.51 km，按公布规则为 6 元。在建的 1 号线南延、3 号线南延、9 号线一期（共 15 站，站名仅以征求意见稿图片发布）无结构化站表，未建模。'
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
      [...interchangeLines.entries()]
        .filter(([, lines]) => lines.size > 1)
        .map(([k, v]) => [k, [...v]] as const)
    ),
    stopsByLineId,
    stationNamesByLineId
  };
}

/** Normalise a source time to `HH:MM`; returns undefined for unusable values. */
function normTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 47 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Lines of the network, in official order. */
