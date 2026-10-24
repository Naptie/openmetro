/**
 * Canonical construction for cn-hefei.
 *
 * ## Sources of truth
 *
 * - **Line order, station set, coordinates, English names, line colours and the
 *   schematic pixel grid** come from the AMap subway dataset. It covers Hefei
 *   completely: 8 lines, 215 line-stop rows, 195 physical stations, every one
 *   of them with a GCJ-02 coordinate, an English name and a pixel position.
 * - **The first/last-train table, its three service-day bands and the service
 *   directions** come from the operator's official 《首末班车时间及行车间隔》.
 * - **The per-station first/last windows** come from the Baidu planner, which
 *   agrees with the official table at every published terminal.
 *
 * ## Direction mapping
 *
 * The operator labels its two service directions 上行 / 下行 and defines them
 * in the table's 注释 column. The repo's convention is the opposite axis:
 * `down` = toward the **last** stop of the line's canonical order, `up` =
 * toward the **first**. For 4 号线 and 5 号线 the operator's 上行 runs toward
 * the *first* stop of the AMap order, so the mapping is resolved per line
 * from the official definition rather than assumed.
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
import type { AmapLine, AmapStation, AmapSubwayDoc, HefeiSources } from './fetch.js';
import {
  ENGLISH_NAME_OVERRIDES,
  HEFEI_LINES,
  type HefeiLineConfig,
  NOT_YET_OPEN_STATIONS,
  resolveHefeiStationName
} from './lines.js';
import {
  type BandTimes,
  bandTimesToWeekArray,
  type HarvestedStationTimes,
  type OfficialLineTimetable,
  type OperatorDirection,
  type ServiceBand
} from './timetables.js';

const NETWORK_ID = 'cn-hefei';
const AMAP_SOURCE = 'amap-subway-3401';
const OFFICIAL_TIMETABLE_SOURCE = 'hefei-gov-first-last-timetable';
const OFFICIAL_NETWORK_MAP_SOURCE = 'hefei-gov-operating-network-map';
const BAIDU_SOURCE = 'baidu-transit-direction';

/** The repo-wide direction axis: `down` heads to the line's last stop. */
type RepoDirection = 'up' | 'down';

/** One physical station, as assembled from the sources. */
interface Phys {
  id: string;
  /** Canonical display name (the AMap spelling). */
  zh: string;
  en: string;
  pinyin?: string;
  location?: { lon: number; lat: number };
  schematic?: { x: number; y: number };
  /** AMap per-line station ids this station carries. */
  codes: string[];
  /** `under_construction` for the stations the official map marks 暂未开通. */
  status: 'operating' | 'under_construction';
  /** The official network map's note for a not-yet-open station. */
  statusNote?: string;
  /** The lines the station is served by. */
  lineIds: Set<string>;
}

export interface HefeiCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coordinates keyed by canonical station id. */
  amapLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Per canonical line id: the line's stops in canonical order. */
  stopsByLineId: Map<string, StopEncoded[]>;
  /** The not-yet-open stations, with their official note. */
  notYetOpen: { stationId: string; name: string; line: string; note: string }[];
}

export interface NormalizeInput {
  sources: HefeiSources;
  /** Per line number: the harvested per-station first/last trains. */
  harvestedTimes?: Map<string, HarvestedStationTimes[]>;
  /** The service-day band the harvest observed. */
  serviceBand?: ServiceBand;
}

/** Strip spaces and case so two spellings can be compared. */
function looseKey(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

/**
 * Is an AMap English label a real English name or just the pinyin in caps?
 *
 * AMap publishes both: `Hefei Railway Station` for a translated name and
 * `JIULIANWEI` for a romanisation it did not translate. The romanisation is
 * better rendered from the `sp` field (`JiuLianWei` → `Jiu Lian Wei`), so the
 * pinyin form is recognised and replaced.
 */
function isPinyinLabel(en: string, sp: string): boolean {
  if (!en || !sp) return false;
  return looseKey(en) === looseKey(sp);
}

/** The AMap station index, keyed by name (first occurrence wins). */
function amapStations(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byName = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !byName.has(n)) byName.set(n, st);
    }
  }
  return byName;
}

/** The AMap line index, keyed by line name. */
function amapLines(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln && !byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}

/** The canonical line configs, in operator order. */
function lineConfigs(): HefeiLineConfig[] {
  return HEFEI_LINES;
}

export function normalizeHefei(input: NormalizeInput): HefeiCanonical {
  const { sources } = input;
  const stationIndex = amapStations(sources.amap);
  const lineIndex = amapLines(sources.amap);
  const knownNames = new Set(stationIndex.keys());

  const physByName = new Map<string, Phys>();
  const physById = new Map<string, Phys>();
  const usedIds = new Set<string>();

  const ensurePhys = (name: string): Phys => {
    const existing = physByName.get(name);
    if (existing) return existing;

    const amap = stationIndex.get(name);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const amapEn = String(amap?.multilang?.n?.en ?? '').trim();
    const en =
      ENGLISH_NAME_OVERRIDES[name] ??
      (amapEn && !isPinyinLabel(amapEn, pinyin ?? '') ? amapEn : '') ??
      '';
    const english = en || pinyinToEnglish(pinyin) || '';

    let id = `${NETWORK_ID}-${stationIdFor(english, name, pinyin)}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const phys: Phys = {
      id,
      zh: name,
      en: english,
      pinyin,
      location: parseSlCoord(amap?.sl),
      schematic: parsePixel(amap?.p),
      codes: [],
      status: 'operating',
      lineIds: new Set()
    };
    physByName.set(name, phys);
    physById.set(id, phys);
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();

  for (const cfg of lineConfigs()) {
    const amap = lineIndex.get(cfg.amapName);
    if (!amap) continue;
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const nameEn = String(amap.multilang?.ln?.en ?? '').trim() || `Line ${cfg.short}`;
    const line: LineEncoded = {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: [],
      color: amap.cl ? `#${amap.cl.replace(/^#/, '').toLowerCase()}` : undefined,
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: {
        line_short_name: cfg.short,
        amap_color: amap.cl,
        amap_line_id: amap.li
      }
    };
    lines.push(line);
    lineById.set(lineId, line);
  }

  // ---- Stops / patterns / segments -----------------------------------------
  const stopsByLineId = new Map<string, StopEncoded[]>();
  const spurStops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();

  for (const cfg of lineConfigs()) {
    const amap = lineIndex.get(cfg.amapName);
    if (!amap) continue;
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const names = (amap.st ?? []).map((s) => String(s.n ?? '').trim()).filter(Boolean);
    if (names.length < 2) continue;

    /** The operating chain: the stops the AMap dataset publishes for the line. */
    const chainStops: StopEncoded[] = [];

    for (const name of names) {
      const phys = ensurePhys(name);
      const amapStation = stationIndex.get(name);
      const code = String(amapStation?.si ?? '').trim();
      if (code && !phys.codes.includes(code)) phys.codes.push(code);
      phys.lineIds.add(lineId);

      chainStops.push({
        id: `${phys.id}-${cfg.short}`,
        station_id: phys.id,
        line_id: lineId,
        sequence: chainStops.length,
        is_terminal: chainStops.length === 0 || chainStops.length === names.length - 1,
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
          official_name: name,
          amap_poiid: amapStation?.poiid || undefined
        }
      });
    }

    // ---- Inline not-yet-open stations ----------------------------------------
    // A station the official network map marks 暂未开通 that sits *inside* the
    // alignment keeps its place in the line's stop list — the operator publishes
    // it between two operating stations (市博物馆 between 市儿童医院 and 钢红).
    // The ride chain skips it, so the hop that runs past it is the through-run
    // the service actually makes; the routing graph drops the station itself
    // because it is not in passenger service.
    const inlinePlanned = NOT_YET_OPEN_STATIONS.filter(
      (p) => p.line === cfg.name && p.position === 'inline'
    );
    const lineStops: StopEncoded[] = [];
    for (const stop of chainStops) {
      // Cloned with the sequence it takes in the published order (the chain's
      // own numbering does not account for the inserted stations).
      lineStops.push({ ...stop, sequence: lineStops.length });
      const officialName = String(stop.extras?.official_name ?? '');
      for (const planned of inlinePlanned.filter((p) => p.after === officialName)) {
        const phys = ensurePhys(planned.name);
        phys.status = 'under_construction';
        phys.statusNote = planned.note;
        phys.lineIds.add(lineId);
        lineStops.push({
          id: `${phys.id}-${cfg.short}`,
          station_id: phys.id,
          line_id: lineId,
          sequence: lineStops.length,
          is_terminal: false,
          location: phys.location
            ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' }
            : undefined,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
            : undefined,
          extras: {
            line_short_name: cfg.short,
            official_name: planned.name,
            not_yet_open: true,
            official_note: planned.note
          }
        });
      }
    }

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
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: {
        line_short_name: cfg.short,
        origin_name: lineStops[0]!.extras?.official_name ?? undefined,
        terminal_name: lineStops[lineStops.length - 1]!.extras?.official_name ?? undefined
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
        source_id: AMAP_SOURCE,
        extras: skipped.length
          ? {
              skips_station_ids: skipped.map((s) => s.station_id),
              skip_note:
                '官方线网图将该站标为暂未开通且位于两个运营站之间，运营交路由此通过；本区间是贯通运行，非相邻站区间。'
            }
          : undefined
      });
    }

    // ---- Not-yet-open stations beyond the line's end -------------------------
    // The official network map marks three stations as 暂未开通. Two of them
    // (馆驿 on 3 号线, 紫云湖 on 4 号线) lie **beyond** the operating terminus,
    // so a **spur** hanging off that anchor is their real shape — the same way
    // the repo records Suzhou's and Ningbo's announced extensions: the stop and
    // its segment exist, but the station is `under_construction` and the routing
    // graph drops it.
    //
    // The third (市博物馆 on 6 号线) sits **between** two operating stations and
    // is handled above, inside the line's own alignment.
    let spurIndex = 0;
    for (const planned of NOT_YET_OPEN_STATIONS) {
      if (planned.line !== cfg.name) continue;
      if (planned.position !== 'extension') continue;
      const anchorStop = lineStops.find((s) => s.extras?.official_name === planned.after);
      if (!anchorStop) {
        console.log(
          `  WARN: ${cfg.name} anchor ${planned.after} not found — ${planned.name} skipped`
        );
        continue;
      }
      const phys = ensurePhys(planned.name);
      phys.status = 'under_construction';
      phys.statusNote = planned.note;
      phys.lineIds.add(lineId);

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

      const spurPatternId = `${lineId}-pattern-spur-${phys.id.split('-').pop()}`;
      patterns.push({
        id: spurPatternId,
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
        source_ids: [{ source: OFFICIAL_NETWORK_MAP_SOURCE, id: planned.name }],
        extras: {
          pattern_status: 'under_construction',
          parent_line_id: lineId,
          connector_station_id: anchorStop.station_id,
          official_note: planned.note
        }
      });

      spurStops.push(spurStop);
      segments.push({
        id: `${NETWORK_ID}-seg-${anchorStop.id}-${spurStop.id}`,
        line_id: lineId,
        from_stop_id: anchorStop.id,
        to_stop_id: spurStop.id,
        from_station_id: anchorStop.station_id,
        to_station_id: spurStop.station_id,
        direction: 'both',
        source_id: OFFICIAL_NETWORK_MAP_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const officialByLine = new Map<string, OfficialLineTimetable>();
  for (const t of sources.timetable) officialByLine.set(t.lineNumber, t);

  /** Resolve an operator station name to the canonical AMap spelling. */
  const canonicalName = (raw: string): string => resolveHefeiStationName(raw, knownNames);

  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const cfg of lineConfigs()) {
    const amap = lineIndex.get(cfg.amapName);
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!amap || !lineStops || !pattern) continue;

    const official = officialByLine.get(cfg.officialId);
    const names = (amap.st ?? []).map((s) => String(s.n ?? '').trim()).filter(Boolean);
    const firstName = names[0]!;
    const lastName = names[names.length - 1]!;

    // The operator's 上行 / 下行 versus the repo's up / down.
    const upToward = official ? canonicalName(official.upToward) : '';
    const operatorUpIsDown = upToward === lastName;

    // The official table's station keys, resolved onto the canonical names.
    const officialFirst = new Map<string, Map<OperatorDirection, BandTimes>>();
    const officialLast = new Map<string, Map<OperatorDirection, BandTimes>>();
    if (official) {
      for (const [raw, byDir] of official.first) {
        officialFirst.set(canonicalName(raw), byDir);
      }
      for (const [raw, byDir] of official.last) {
        officialLast.set(canonicalName(raw), byDir);
      }
    }

    const harvested = input.harvestedTimes?.get(cfg.officialId);
    const harvestedByName = new Map((harvested ?? []).map((r) => [r.stationName, r] as const));

    for (const stop of lineStops) {
      const phys = physById.get(stop.station_id);
      if (!phys) continue;
      const name = phys.zh;

      const firstOfficial = officialFirst.get(name);
      const lastOfficial = officialLast.get(name);
      const row = harvestedByName.get(name);

      const directions: RepoDirection[] = ['down', 'up'];
      for (const repoDir of directions) {
        const operatorDir: OperatorDirection =
          (repoDir === 'down') === operatorUpIsDown ? 'operatorUp' : 'operatorDown';

        const officialFirstTimes = firstOfficial?.get(operatorDir);
        const officialLastTimes = lastOfficial?.get(operatorDir);
        const baiduFirst = repoDir === 'down' ? row?.downFirst : row?.upFirst;
        const baiduLast = repoDir === 'down' ? row?.downLast : row?.upLast;
        const baiduLabel = repoDir === 'down' ? row?.downDirection : row?.upDirection;
        const baiduExit = repoDir === 'down' ? row?.downExit : row?.upExit;

        const firstTrain = officialFirstTimes
          ? bandTimesToWeekArray(officialFirstTimes)
          : baiduFirst
            ? [baiduFirst]
            : undefined;
        const lastTrain = officialLastTimes
          ? bandTimesToWeekArray(officialLastTimes)
          : baiduLast
            ? [baiduLast]
            : undefined;
        if (!firstTrain || !lastTrain) continue;

        const destStop = repoDir === 'down' ? lineStops[lineStops.length - 1]! : lineStops[0]!;
        const originStop = repoDir === 'down' ? lineStops[0]! : lineStops[lineStops.length - 1]!;
        const id = `${NETWORK_ID}-tt-${stop.id}-to-${destStop.id}`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);

        const source = officialFirstTimes ? 'official' : 'baidu';
        const terminusName = repoDir === 'down' ? lastName : firstName;
        const baiduSide = !officialFirstTimes || !officialLastTimes;
        timetables.push({
          id,
          station_id: stop.station_id,
          stop_id: stop.id,
          line_id: lineId,
          station_code: stop.source_id,
          source_id: source === 'official' ? OFFICIAL_TIMETABLE_SOURCE : BAIDU_SOURCE,
          destination_stop_id: destStop.id,
          origin_stop_id: originStop.id,
          pattern_id: pattern.id,
          direction_type: 'linear',
          // The official direction definition is authoritative. The planner
          // labels 3 号线 "馆驿方向" and 4 号线 "紫云湖方向" — the stations
          // that are still under construction and not the operating terminus —
          // so its label is kept as provenance instead.
          direction_label: `${terminusName}方向`,
          // At the destination terminus of a direction the published "last
          // train" is the train that **arrives** there (the operator lists the
          // terminal's last train under the direction that runs into it — 7 号线
          // does so for 省文化和非遗馆).
          is_arrival: destStop.id === stop.id ? true : undefined,
          first_train: firstTrain,
          last_train: lastTrain,
          service: 'all_days',
          extras: {
            direction: repoDir,
            operator_direction: operatorDir === 'operatorUp' ? '上行' : '下行',
            destination_name: terminusName,
            first_source: officialFirstTimes ? 'official' : baiduFirst ? 'baidu' : undefined,
            last_source: officialLastTimes ? 'official' : baiduLast ? 'baidu' : undefined,
            // The band the **Baidu** side belongs to. The official side carries
            // all three bands in its 7-element array, so it needs no band.
            service_band: baiduSide ? input.serviceBand : undefined,
            planner_exit: baiduExit,
            planner_direction: baiduLabel,
            official_headway: official?.headway
              ? Object.entries(official.headway)
                  .map(([band, text]) => `${band}=${text}`)
                  .join('; ')
              : undefined,
            source_note:
              source === 'official'
                ? '首/末班时刻取自合肥市人民政府政府信息公开平台发布的《合肥轨道1、2、3、4、5、6、7、8号线首末班车时间及行车间隔》（发布机构：合肥市轨道交通集团），含周一至周四工作日、周五工作日、双休日三个服务日带，落盘为 7 元素星期数组（0=周一）。官方仅公布首班车始发站与末班车终到站，中间车站的时刻由百度路径规划补齐。'
                : '逐站首末班取自百度路径规划 direction/v2/transit（tactics_incity=5 地铁优先）：detail.first_time / detail.last_time 为上车站自身的首班/末班发车时刻，在官方公布的终点站上与官方表逐格一致。规划器只回答查询当日所在的服务日带，故 service_band 标明本次采集所属档位。'
          }
        });
      }
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  const amapLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const notYetOpen: HefeiCanonical['notYetOpen'] = [];

  for (const phys of physByName.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (loc) amapLocations.set(phys.id, loc);

    if (phys.status === 'under_construction') {
      notYetOpen.push({
        stationId: phys.id,
        name: phys.zh,
        line: [...phys.lineIds].map((id) => lineById.get(id)?.name ?? id).join('、'),
        note: phys.statusNote ?? ''
      });
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
      source_ids: [
        { source: AMAP_SOURCE, id: phys.zh },
        ...phys.codes.map((c) => ({ source: AMAP_SOURCE, id: c }) as const),
        ...(phys.status === 'under_construction'
          ? [{ source: OFFICIAL_NETWORK_MAP_SOURCE, id: phys.zh } as const]
          : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        official_station_codes: phys.codes.length ? phys.codes : undefined,
        lines: [...phys.lineIds].map((id) => lineById.get(id)?.name ?? id),
        service_status_note: phys.statusNote
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '合肥地铁',
    names: { zh: '合肥地铁', en: 'Hefei Metro' },
    city: placeholderCity('CN-3401'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 900 },
    notes:
      '线网拓扑（线路、站序、线色、示意图像素）、坐标与英文名取自 AMap Subway 3401_drw_hefei.json（GCJ-02 原生，8 线 215 站序行 / 195 座车站全部带坐标、英文名与像素位置）。' +
      '官方结构化运营数据不在集团官网（www.hfgdjt.com 是网页隔离代理壳，无任何业务接口），而在合肥市人民政府政府信息公开平台「合肥市轨道交通集团有限公司」栏目（organId=156407）：《首末班车时间及行车间隔》给出 8 条线、周一至周四工作日/周五工作日/双休日三个服务日带的首末班时刻、始发站、终到站与最小行车间隔；《票价信息及优惠政策》给出里程分段计价票制（起步 2 元 8 公里，8-14 公里 3 元，14-21 公里 4 元，21-29 公里 5 元，29 公里以上每 9 公里加收 1 元）；《运营线路》给出官方运营线网图。' +
      '官方时刻表只公布首班车始发站与末班车终到站，逐站首末班由百度路径规划 direction/v2/transit 补齐——在官方公布的 7 个终点站上与官方表逐格一致（九联圩 06:00/22:50、合肥南站 06:04/23:55、张洼 06:00/23:10、南岗 06:00/23:00、相城路 06:00/22:25、龙塘 06:00/22:00、一里井 06:00/22:30，2026-10-23 周五）。' +
      '官方线网图把馆驿（3 号线）、紫云湖（4 号线）、市博物馆（6 号线）标为暂未开通。三站状态均记为 under_construction，建模方式按其在线路中的位置区分：馆驿与紫云湖在线路末端之外，记为挂在相邻运营站上的支线交路；市博物馆位于市儿童医院与钢红之间，保留在 6 号线的官方站序中，运营交路不在该站停靠，乘车区间按贯通运行建模——市儿童医院→钢红 是运营方实际开行的一个区间，而非两个相邻站区间。三种情况下路由图都丢弃这些站，运营主线不被拆断。' +
      '官方时刻表按三个服务日带（周一至周四工作日 / 周五工作日 / 双休日）公布，落盘为 7 元素星期数组；中间车站的时刻由百度规划器补齐，规划器只回答采集当日所在的服务日带，该档位记录在 timetables 的 service_band 中。规划器的方向标签在 3 号线与 4 号线指向仍在建的馆驿与紫云湖，方向一律以官方定义为准，规划器原标签保留在 extras.planner_direction。' +
      '官方不发布区间运行时间、区间里程、换乘步行时间与站内出入口信息，这三类数据由百度规划器与 core 的 gapfill 层补齐。' +
      '区间里程以百度路径规划逐区间实测为准；个别 OD 规划器不给出路线（终点是官网标注暂未开通的车站），或只给出公交与步行方案、没有地铁方案，此时不套用公交里程，改用直线距离估算——这类区间在 segments.json 中以 distance_source=haversine 标注，数量随规划器当次的应答而定。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopsByLineId.values()].flat().concat(spurStops),
    patterns,
    segments,
    timetables,
    amapLocations,
    stopsByLineId,
    notYetOpen
  };
}
