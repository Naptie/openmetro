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
  NanningSources,
  OfficialLine,
  OfficialStationDetail
} from './fetch.js';
import {
  ENGLISH_NAME_OVERRIDES,
  LINE_CONFIG_BY_OFFICIAL_ID,
  type NanningLineConfig,
  type NanningPlannedStation,
  PLANNED_STATIONS
} from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-nanning';
const OFFICIAL_SOURCE = 'nngdjt-subway-page';
const OFFICIAL_TIMETABLE_SOURCE = 'nngdjt-first-last-sheets';
const AMAP_SOURCE = 'amap-subway-4501';

export interface NanningCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** Per canonical line id: the line's stops in official line order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** Canonical station id → the operator's line numbers that serve it. */
  officialLinesByStationId: Map<string, string[]>;
  /** The operator's station name → canonical station id. */
  plannerKeyByOfficialName: Map<string, string>;
  /** Canonical station id → AMap GCJ-02 coordinates. */
  amapLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

/**
 * AMap's English label, normalised to the repo's title-case convention.
 *
 * AMap publishes Nanning's station names in two shapes: real English names
 * ("Nanning East Railway Station", "Convention & Exhibition Center") and
 * straight pinyin ("FOZILING", "JINHU Square"). The repository's AMap-only
 * cities use title case ("Foziling", "Jinhu Square"), so an all-caps word is
 * title-cased — but only when it is a pinyin syllable of this station, so a
 * real acronym keeps its shape ("ASEAN Business District").
 */
export function englishNameFor(amap: AmapStation | undefined): string {
  const label = String(amap?.multilang?.n?.en ?? '').trim();
  if (!label) return '';
  const pinyin = String(amap?.sp ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!pinyin) return label;

  return label
    .split(/(\s+)/)
    .map((word) => {
      if (!/^[A-Z]{2,}$/.test(word)) return word;
      const title = word[0] + word.slice(1).toLowerCase();
      return pinyin.startsWith(title.toLowerCase()) ? title : word;
    })
    .join('');
}

function amapLineByNumber(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byNumber = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const number = (String(line.ln ?? '').match(/(\d+)号线/) ?? [])[1];
    if (number && !byNumber.has(number)) byNumber.set(number, line);
  }
  return byNumber;
}

function amapStationByName(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byName = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !byName.has(n)) byName.set(n, st);
    }
  }
  return byName;
}

/** Registry entry for an official line. */
function configFor(official: OfficialLine): NanningLineConfig {
  const known = LINE_CONFIG_BY_OFFICIAL_ID.get(official.officialId);
  if (known) return known;
  const short = official.officialId;
  return {
    officialId: short,
    short,
    name: official.name,
    slug: short,
    mode: 'metro',
    baiduNameHint: `轨道交通${short}号线`
  };
}

export interface NormalizeInput {
  sources: NanningSources;
  /** Per official line id: the harvested per-station first/last trains. */
  harvestedTimes?: Map<string, HarvestedStationTimes[]>;
  /**
   * Which band of the operator's weekday/weekend split the harvested first/last
   * trains belong to (see `./timetables.ts`).
   */
  serviceBand?: 'mon_thu' | 'fri_weekend';
  /**
   * Coordinates for the stations no other source publishes.
   *
   * 五象火车站 is announced but not in service, so the AMap subway dataset does
   * not carry it; the planner's place index does. Without a coordinate its
   * segment would have neither a distance nor a run time.
   */
  plannedCoordinates?: Map<string, { lon: number; lat: number }>;
}

export function normalizeNanning(input: NormalizeInput): NanningCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByNumber(sources.amap);
  const amapStationIndex = amapStationByName(sources.amap);
  const plannedByLine = new Map<string, NanningPlannedStation[]>();
  for (const planned of PLANNED_STATIONS) {
    const list = plannedByLine.get(planned.line) ?? [];
    list.push(planned);
    plannedByLine.set(planned.line, list);
  }

  type Phys = {
    id: string;
    /** Canonical display name — the operator's own spelling. */
    zh: string;
    /** The operator's station id (`subway-site-info-<id>`). */
    officialId: string;
    en: string;
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    /** AMap per-line station codes this station carries. */
    codes: string[];
    status: 'operating' | 'under_construction';
    statusNote?: string;
  };

  const physByName = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const amapLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const usedIds = new Set<string>();

  const ensurePhys = (name: string, officialId: string): Phys => {
    const existing = physByName.get(name);
    if (existing) return existing;

    const amap = amapStationIndex.get(name);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const en =
      ENGLISH_NAME_OVERRIDES[name] ?? (englishNameFor(amap) || pinyinToEnglish(pinyin) || '');

    const loc = parseSlCoord(amap?.sl) ?? input.plannedCoordinates?.get(name);
    const pix = parsePixel(amap?.p);

    let id = `${NETWORK_ID}-${stationIdFor(en, name, pinyin)}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const phys: Phys = {
      id,
      zh: name,
      officialId,
      en,
      pinyin,
      location: loc,
      schematic: pix,
      codes: [],
      status: 'operating'
    };
    physByName.set(name, phys);
    physById.set(id, phys);
    if (loc) amapLocations.set(id, { ...loc, crs: 'gcj02' });
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { official: OfficialLine; cfg: NanningLineConfig }[] = [];

  for (const official of sources.official.lines) {
    const cfg = configFor(official);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    if (lineById.has(id)) continue;

    const amap = amapLineIndex.get(official.officialId);
    const nameEn =
      String(amap?.multilang?.kn?.en ?? amap?.multilang?.ln?.en ?? '').trim() ||
      `Line ${cfg.short}`;

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
        ...(official.timetableImage
          ? [{ source: OFFICIAL_TIMETABLE_SOURCE, id: official.timetableImage }]
          : []),
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.officialId,
        official_stop_count: official.stops.length,
        terminals: official.terminals ?? undefined,
        official_timetable_image: official.timetableImage ?? undefined,
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
  const officialLinesByStationId = new Map<string, string[]>();
  const plannerKeyByOfficialName = new Map<string, string>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    /** The line's published stop list — the operator's order, not-yet-open stops included. */
    const lineStops: StopEncoded[] = [];
    /** The operating chain: the stops a service actually calls at. */
    const chainStops: StopEncoded[] = [];
    const plannedHere = plannedByLine.get(official.officialId) ?? [];
    const plannedSpecByName = new Map(plannedHere.map((p) => [p.name, p] as const));
    // The service starts and ends at the operating chain's ends, which the
    // published order alone does not tell when a not-yet-open station sits at
    // either end of the list.
    const chainIndexes = official.stops
      .map((s, i) => (plannedSpecByName.has(s.name) ? -1 : i))
      .filter((i) => i >= 0);
    const firstChainIndex = chainIndexes[0];
    const lastChainIndex = chainIndexes[chainIndexes.length - 1];

    // The operator's page lists the stops in official line order; that order is
    // authoritative — including the station it lists but does not yet operate
    // (五象火车站 on Line 4: the first/last-train sheet gives it `/` in every
    // time column and the operating network map omits it).
    //
    // Such a station keeps its **place in the line's alignment** — it is a
    // published stop of Line 4, between 楞塘村 and 清平坡 — but it is not a stop
    // of any service, so the ride chain skips it and the hop that runs past it
    // is the through-run the service actually makes. Modelling it as a spur off
    // 楞塘村 would instead assert a dead-end branch that does not exist and
    // take the station out of the alignment the operator publishes.
    for (const [index, stop] of official.stops.entries()) {
      const phys = ensurePhys(stop.name, stop.officialId);
      const planned = plannedSpecByName.get(stop.name);
      if (planned) {
        phys.status = 'under_construction';
        phys.statusNote = planned.note;
      }
      const amap = amapStationIndex.get(stop.name);
      const code = String(amap?.si ?? '').trim();
      if (code && !phys.codes.includes(code)) phys.codes.push(code);

      const set = lineIdsByStation.get(phys.id) ?? new Set<string>();
      set.add(lineId);
      lineIdsByStation.set(phys.id, set);

      const officialLineList = officialLinesByStationId.get(phys.id) ?? [];
      if (!officialLineList.includes(official.officialId)) {
        officialLineList.push(official.officialId);
      }
      officialLinesByStationId.set(phys.id, officialLineList);
      plannerKeyByOfficialName.set(stop.name, phys.id);

      const stopRec: StopEncoded = {
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        sequence: index,
        is_terminal: index === firstChainIndex || index === lastChainIndex,
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
          official_name: stop.name,
          official_station_id: stop.officialId,
          amap_poiid: amap?.poiid || undefined,
          ...(planned
            ? {
                not_yet_open: true,
                official_note: planned.note
              }
            : {})
        }
      };
      lineStops.push(stopRec);
      if (!planned) chainStops.push(stopRec);
    }

    if (chainStops.length < 2) continue;

    const firstStop = chainStops[0]!;
    const lastStop = chainStops[chainStops.length - 1]!;

    stopsByLineId.set(lineId, lineStops);

    const patternId = `${lineId}-pattern-main`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}` },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: firstStop.id,
      terminal_stop_id: lastStop.id,
      is_primary: true,
      source_ids: [{ source: OFFICIAL_SOURCE, id: official.officialId }],
      extras: {
        line_short_name: cfg.short,
        origin_name: firstStop.extras?.official_name,
        terminal_name: lastStop.extras?.official_name
      }
    });

    // Ride edges follow the operating chain. A hop that runs past a station the
    // operator lists but does not serve is the **through-run** the service
    // actually makes, so it is labelled with the stop(s) it passes.
    const patternIndex = new Map(lineStops.map((s, i) => [s.id, i] as const));
    for (let i = 0; i + 1 < chainStops.length; i++) {
      const a = chainStops[i]!;
      const b = chainStops[i + 1]!;
      const key = [a.id, b.id].sort().join('|');
      if (segmentKeys.has(key)) continue;
      segmentKeys.add(key);
      const aIdx = patternIndex.get(a.id)!;
      const bIdx = patternIndex.get(b.id)!;
      const skipped = lineStops.filter((s) => {
        const idx = patternIndex.get(s.id)!;
        return idx > aIdx && idx < bIdx;
      });
      segments.push({
        id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        source_id: OFFICIAL_SOURCE,
        extras: skipped.length
          ? {
              skips_station_ids: skipped.map((s) => s.station_id),
              skip_note:
                '运营方站表列出该站但尚未开通（首末班时刻表各时间列为「/」，运营线网图未收录），运营交路由此通过；本区间是贯通运行，非相邻站区间。'
            }
          : undefined
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const rows = input.harvestedTimes?.get(official.officialId);
    if (!lineStops || !rows) continue;

    const pattern = patterns.find((p) => p.line_id === lineId && p.is_primary);
    if (!pattern) continue;

    const rowByName = new Map(rows.map((r) => [r.stationName, r] as const));
    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;

    for (const stop of lineStops) {
      const station = physById.get(stop.station_id);
      if (!station) continue;
      const row = rowByName.get(station.zh);
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
              '逐站逐方向首末班取自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：detail.first_time / detail.last_time 为该方向上车站自身的首班/末班发车时刻，与官网首末班车时刻表逐格一致（官网仅以图片发布该表，未做 OCR）。官网时刻表分「周一至周四」与「每周五、周末及节假日」两档，规划器只回答查询当日所在档，故 service_band 标明本次采集所属档位。'
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
    if (loc) amapLocations.set(phys.id, loc);

    const detail: OfficialStationDetail | undefined = sources.official.stations.get(phys.zh);
    const exits = detail?.exits ?? [];
    const exitLandmarks: Record<string, string[]> = {};
    for (const exit of exits) {
      if (exit.landmarks.length) exitLandmarks[exit.exit] = exit.landmarks;
    }

    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: phys.status,
      identity_notes: phys.statusNote,
      source_ids: [
        { source: OFFICIAL_SOURCE, id: phys.officialId },
        ...phys.codes.map((c) => ({ source: AMAP_SOURCE, id: c }) as const)
      ],
      extras: {
        pinyin: phys.pinyin,
        official_name: phys.zh,
        official_station_id: phys.officialId,
        official_station_codes: phys.codes.length ? phys.codes : undefined,
        description: detail?.description,
        exits: exits.length ? exits.map((e) => e.exit) : undefined,
        exit_landmarks: Object.keys(exitLandmarks).length ? exitLandmarks : undefined,
        transfer_note: detail?.transferNote,
        facilities_image: detail?.facilitiesImage
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '南宁轨道交通',
    names: { zh: '南宁轨道交通', en: 'Nanning Rail Transit' },
    city: placeholderCity('CN-4501'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与站序来自运营方官网的服务端渲染页面 GET https://www.nngdjt.com/traffic/subway/?pageIndex=1：1 号线 25 站（火车东站→石埠）、2 号线 23 站（西津→坛泽）、3 号线 23 站（科园大道→平良立交）、4 号线 19 站（洪运路→龙岗）、5 号线 17 站（国凯大道→金桥客运站），共 107 条 line-stop 记录、96 座物理车站、11 座换乘站（金湖广场、朝阳广场、火车站、广西大学、安吉客运站、明秀路、大沙田、平良立交、小鸡村、总部基地、那洪立交）。4 号线的五象火车站官网时刻表六个时间列均为「/」、运营线网图亦未收录，属已官宣未通车：它保留在 4 号线的官方站序中（楞塘村 → 五象火车站 → 清平坡），状态记为 under_construction。运营交路不在该站停靠，因此乘车区间按贯通运行建模——楞塘村→清平坡 是运营方实际开行的一个区间，而非两个相邻站区间；路由图因该站非运营而将其剔除，4 号线本身不被拆断。每站详情块另给出车站描述、全部出入口（含每个口的周边地标，共 407 条）、换乘指引与设施示意图。坐标、示意图像素、线内站码、拼音、英文名与线色来自 AMap Subway 4501（GCJ-02 原生；AMap 尚无五象火车站，站序与官网一致）。逐站逐方向首末班来自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：该接口给出上车站自身的首班/末班发车时刻，与官网首末班车时刻表逐格一致（192 组比对中 190 组完全一致，官网仅以图片发布该表，未做 OCR）。OD 票价来自同一规划器的逐 OD 报价，官网未提供票价矩阵也未提供路径规划器；票务须知图给出官方里程分段计价规则（起步 2 元/6 公里，之后 6/6/8/8 公里各加 1 元，34 公里以上每 10 公里加 1 元）用于交叉校验与缺格兜底。换乘步行时间官方不提供，依赖 core 的 gapfill 层由百度规划器补齐。' +
      '区间里程以百度路径规划逐区间实测为准；个别 OD 规划器只给出公交与步行方案、没有地铁方案，此时不套用公交里程，改用直线距离估算——这类区间在 segments.json 中以 distance_source=haversine 标注，数量随规划器当次的应答而定。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopsByLineId.values()].flat(),
    patterns,
    segments,
    timetables,
    stopsByLineId,
    officialLinesByStationId,
    plannerKeyByOfficialName,
    amapLocations
  };
}
