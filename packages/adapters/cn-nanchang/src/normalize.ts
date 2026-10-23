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
  NanchangSources,
  OfficialAllLine,
  OfficialSiteInfo
} from './fetch.js';
import {
  canonicalStationName,
  ENGLISH_NAME_OVERRIDES,
  foldNanchangStationName,
  NANCHANG_LINES,
  type NanchangLineConfig
} from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-nanchang';
const OFFICIAL_SOURCE = 'ncmtr-allline';
const AMAP_SOURCE = 'amap-subway-3601';

/** A measured official run time for one adjacent stop pair. */
export interface OfficialSegmentTime {
  /** Seconds the operator's planner quotes for the hop. */
  seconds: number;
  /** The planner's own total for the queried hop, in minutes. */
  minutes: number;
}

export interface NanchangCanonical {
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
  /** Per canonical line id: the line's stops in official line order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Official planner key (the operator's own station name, with `站`) → id. */
  plannerKeyByOfficialName: Map<string, string>;
  /** The operator's line ids (as strings) each station is served by. */
  officialLinesByStationId: Map<string, string[]>;
  /**
   * Folded station name → canonical display name.
   *
   * AMap keeps the `站` suffix on a few compounds (`南昌西站`, `南昌东站`)
   * while the operator appends it everywhere, so the two feeds only line up
   * after the fold. This map lets the adapter re-key the AMap dataset onto
   * the canonical names for the geocoding cascade.
   */
  canonicalNameByFold: Map<string, string>;
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
      const key = foldNanchangStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

/**
 * The operator's lines, in the order the payload lists them.
 *
 * `AllLine.data` is keyed by line id and each entry already carries the stops
 * in official line order, so the payload is used verbatim.
 */
function officialLines(
  official: OfficialAllLine
): { officialId: string; stations: { siteName: string }[] }[] {
  const out: { officialId: string; stations: { siteName: string }[] }[] = [];
  for (const [officialId, stations] of Object.entries(official.data ?? {})) {
    if (!Array.isArray(stations) || stations.length < 2) continue;
    out.push({
      officialId,
      stations: stations.map((s) => ({ siteName: String(s.siteName ?? '').trim() }))
    });
  }
  return out.sort((a, b) => a.officialId.localeCompare(b.officialId));
}

/**
 * Registry entry for an official line.
 *
 * The operator's payload is authoritative for the name and the stops; the
 * registry only adds the canonical id slug and the planner's vehicle-name
 * fragment. An unknown official line still gets a usable config.
 */
function configFor(
  officialId: string,
  name: string,
  byOfficialId: Map<string, NanchangLineConfig>
): NanchangLineConfig {
  const known = byOfficialId.get(officialId);
  if (known) return known;
  const short = name.replace(/号线$/, '') || officialId;
  return {
    officialId,
    short,
    name,
    slug: short.replace(/[^A-Za-z0-9]+/g, '') || officialId,
    mode: 'metro',
    baiduNameHint: `地铁${short}号线`
  };
}

export interface NormalizeInput {
  sources: NanchangSources;
  /** Per official line id: the harvested per-station first/last trains. */
  harvestedTimes?: Map<string, HarvestedStationTimes[]>;
  /**
   * Official run times for adjacent stop pairs, keyed by
   * `"<fromStopId>|<toStopId>"` (the pair as it appears in line order).
   */
  officialSegmentTimes?: Map<string, OfficialSegmentTime>;
  /** The operator's per-station exits / bus interchange, by official name. */
  siteInfo?: Map<string, OfficialSiteInfo[]>;
  /**
   * Which band of the operator's weekday/weekend split the harvested first/last
   * trains belong to (see `./timetables.ts`).
   */
  serviceBand?: 'mon_thu' | 'fri_weekend';
}

export function normalizeNanchang(input: NormalizeInput): NanchangCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);
  const cfgByOfficialId = new Map(NANCHANG_LINES.map((c) => [c.officialId, c] as const));

  type Phys = {
    id: string;
    /** Canonical display name (no trailing 站, except 南昌火车站). */
    zh: string;
    /** The operator's own name, with the 站 suffix. */
    officialName: string;
    /** Match key shared by the operator's and AMap's payloads. */
    foldKey: string;
    en: string;
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    /** AMap per-line station codes this station carries. */
    codes: string[];
  };

  const physByFold = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const amapLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const usedIds = new Set<string>();

  const ensurePhys = (officialName: string): Phys => {
    const foldKey = foldNanchangStationName(officialName);
    const existing = physByFold.get(foldKey);
    if (existing) return existing;

    const amap = amapStationIndex.get(foldKey);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const zh = canonicalStationName(officialName);

    // English name: a hand-maintained correction first, then the source's own
    // label, then a romanisation of the pinyin.
    const amapEn = String(amap?.multilang?.n?.en ?? '').trim();
    const en = ENGLISH_NAME_OVERRIDES[zh] ?? (amapEn || pinyinToEnglish(pinyin) || '');

    const loc = parseSlCoord(amap?.sl);
    const pix = parsePixel(amap?.p);

    let id = `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`;
    if (usedIds.has(id)) {
      // Two stations can romanise to the same slug (the operator's 站 suffix is
      // the only difference) — keep the id unique rather than merging them.
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const phys: Phys = {
      id,
      zh,
      officialName,
      foldKey,
      en,
      pinyin,
      location: loc,
      schematic: pix,
      codes: []
    };
    physByFold.set(foldKey, phys);
    physById.set(id, phys);
    if (loc) amapLocations.set(id, { ...loc, crs: 'gcj02' });
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { officialId: string; cfg: NanchangLineConfig; names: string[] }[] = [];

  for (const official of officialLines(sources.official)) {
    const names = official.stations.map((s) => s.siteName);
    const cfg = configFor(official.officialId, `${official.officialId}号线`, cfgByOfficialId);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    if (lineById.has(id)) continue;

    const amap = amapLineIndex.get(cfg.name);
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
        { source: OFFICIAL_SOURCE, id: official.officialId },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.officialId,
        official_stop_count: names.length,
        amap_color: amap?.cl,
        baidu_name_hint: cfg.baiduNameHint
      }
    };
    lines.push(line);
    lineById.set(id, line);
    lineCfgs.push({ officialId: official.officialId, cfg, names });
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const lineIdsByStation = new Map<string, Set<string>>();
  const officialLinesByStationId = new Map<string, string[]>();
  const plannerKeyByOfficialName = new Map<string, string>();

  for (const { officialId, cfg, names } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops: StopEncoded[] = [];

    // The operator's payload lists the stops in official line order; that order
    // is authoritative. (AMap publishes Line 3 in the opposite order, so only
    // per-station attributes are taken from AMap, never the sequence.)
    for (let i = 0; i < names.length; i++) {
      const officialName = names[i]!;
      const phys = ensurePhys(officialName);
      const amap = amapStationIndex.get(phys.foldKey);
      const code = String(amap?.si ?? '').trim();
      if (code && !phys.codes.includes(code)) phys.codes.push(code);

      const set = lineIdsByStation.get(phys.id) ?? new Set<string>();
      set.add(lineId);
      lineIdsByStation.set(phys.id, set);

      const officialLineList = officialLinesByStationId.get(phys.id) ?? [];
      if (!officialLineList.includes(officialId)) officialLineList.push(officialId);
      officialLinesByStationId.set(phys.id, officialLineList);
      plannerKeyByOfficialName.set(officialName, phys.id);

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
        source_id: code || undefined,
        extras: {
          line_short_name: cfg.short,
          station_code: code || undefined,
          official_name: officialName,
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
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: lineStops[0]!.id,
      terminal_stop_id: lineStops[lineStops.length - 1]!.id,
      is_primary: true,
      source_ids: [{ source: OFFICIAL_SOURCE, id: officialId }],
      extras: {
        line_short_name: cfg.short,
        origin_name: canonicalStationName(names[0] ?? ''),
        terminal_name: canonicalStationName(names[names.length - 1] ?? '')
      }
    });

    for (let i = 0; i + 1 < lineStops.length; i++) {
      const a = lineStops[i]!;
      const b = lineStops[i + 1]!;
      const key = [a.id, b.id].sort().join('|');
      if (segmentKeys.has(key)) continue;
      segmentKeys.add(key);
      const measured = input.officialSegmentTimes?.get(`${a.id}|${b.id}`);
      segments.push({
        id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        ...(measured
          ? {
              travel_time_seconds: measured.seconds,
              travel_time_source: 'source' as const,
              source_id: 'ncmtr-route-planner'
            }
          : { source_id: OFFICIAL_SOURCE })
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { officialId, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const rows = input.harvestedTimes?.get(officialId);
    if (!lineStops || !rows) continue;

    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!pattern) continue;

    const rowByName = new Map(
      rows.map((r) => [foldNanchangStationName(r.stationName), r] as const)
    );
    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;

    for (const stop of lineStops) {
      const station = physById.get(stop.station_id);
      if (!station) continue;
      const row = rowByName.get(station.foldKey);
      if (!row) continue;

      // Direction convention (repo-wide):
      //   down = toward the LAST stop of the line's official order,
      //   up   = toward the FIRST stop.
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
            service_band: input.serviceBand,
            source_note:
              '逐站首末班取自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：detail.first_time / detail.last_time 为该方向上车站自身的首班/末班发车时刻，与官网公布的首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）。官网时刻表分「周一至周四」与「每周五、周末及节假日」两档，规划器只回答查询当日所在档，故 service_band 标明本次采集所属档位。'
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

    const info = input.siteInfo?.get(phys.officialName);
    const exits = (info ?? [])
      .map((i) => String(i.entranceAndExitName ?? '').trim())
      .filter(Boolean);
    const busStops = (info ?? [])
      .map((i) => ({
        stop: String(i.busStopName ?? '').trim(),
        routes: String(i.busRoutes ?? '').trim()
      }))
      .filter((b) => b.stop && b.stop !== '无');

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
        { source: OFFICIAL_SOURCE, id: phys.officialName },
        ...phys.codes.map((c) => ({ source: AMAP_SOURCE, id: c }) as const)
      ],
      extras: {
        pinyin: phys.pinyin,
        official_name: phys.officialName,
        official_station_codes: phys.codes.length ? phys.codes : undefined,
        exits: exits.length ? exits : undefined,
        bus_interchange: busStops.length ? busStops : undefined
      }
    });
  }

  const interchanges = new Map<string, string[]>(
    [...lineIdsByStation.entries()]
      .filter(([, lineIds]) => lineIds.size > 1)
      .map(([stationId, lineIds]) => [stationId, [...lineIds]] as const)
  );

  const canonicalNameByFold = new Map<string, string>(
    [...physByFold.values()].map((p) => [p.foldKey, p.zh] as const)
  );

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '南昌轨道交通',
    names: { zh: '南昌轨道交通', en: 'Nanchang Rail Transit' },
    city: placeholderCity('CN-3601'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与站序来自运营方官方接口 GET https://custproj00042-2.ceydz.com/guidao/apiNcdtFrontEnd/AllLine：1 号线 34 站（昌北机场→麻丘）、2 号线 37 站（南路→南昌东站）、3 号线 22 站（银三角北→京东大道）、4 号线 29 站（白马山→鱼尾洲），共 122 条 line-stop 记录、113 座物理车站、9 座换乘站（八一广场、地铁大厦、八一馆、丁公路北、青山路口、西站南广场、丁公路南、绳金塔、上沙沟），与 AMap 的 t=1 换乘标记完全一致。4 条线均为单链无分支，每线 1 个 primary pattern。官方接口 POST /newselectByTowSiteName 同时给出官方 OD 票价（Price）、分线路径（routesToList）与每段行程分钟数（gegeshijiantime）：线路号必须属于该站所属线，否则后端返回 HTTP 500，采集时按站→线组合展开重试；gegeshijiantime 对同线连续区段只给整段耗时，故逐区间官方耗时以「相邻站查询」按需采集（每线 N-1 次），写入 travel_time_source=source。OD 票价矩阵由同一接口逐 OD 采集（113 站 × 112 = 6328 对），与官网公布的里程分段计价（起步 2 元/6 公里，6-12 公里每增 1 元多乘 6 公里，12-28 公里每增 1 元多乘 8 公里，28 公里以上每增 1 元多乘 10 公里）一致。坐标、示意图像素、线内站码、拼音、英文名与线色来自 AMap Subway 3601（GCJ-02 原生；AMap 3 号线站序与官网相反，故站序以官网为准；AMap 的站名后缀 站 与官网不完全一致，两侧各去一个尾缀后逐站一一对应）。逐站逐方向首末班来自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：该接口给出上车站自身的首班/末班发车时刻，与官网首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）。换乘步行时间官方只给次数，依赖 core 的 gapfill 层由百度规划器补齐。'
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
    stopsByLineId,
    plannerKeyByOfficialName,
    officialLinesByStationId,
    canonicalNameByFold
  };
}
