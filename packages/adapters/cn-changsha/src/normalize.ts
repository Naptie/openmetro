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
import type {
  AmapLine,
  AmapStation,
  AmapSubwayDoc,
  ChangshaSources,
  CsmtrLine,
  CsmtrStation
} from './fetch.js';
import {
  type ChangshaLineConfig,
  decodeHtmlEntities,
  ENGLISH_NAME_OVERRIDES,
  LINE_CONFIG_BY_OFFICIAL_CODE,
  OFFICIAL_NAME_OVERRIDES
} from './lines.js';
import {
  buildDirectionTimetables,
  parseOfficialTimes,
  type ResolvedDirection
} from './timetables.js';

const NETWORK_ID = 'cn-changsha';
const CSMTR_SOURCE = 'hncsmtr-creatorcms';
const AMAP_SOURCE = 'amap-subway-4301';

export interface ChangshaCanonical {
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

/**
 * Name keys a station can be found by.
 *
 * The operator's `times` labels name destinations by their short form
 * (`机场`, `高铁` for the maglev, `湘潭北` for 湘潭北站), while the station
 * list carries the full name. `foldStationName` already normalises the
 * brackets and drops a trailing `站`, so the remaining gap is the maglev's
 * `磁浮` prefix — covered by the suffix match in `resolveDestination`.
 */
function nameKeys(name: string): string[] {
  const folded = foldStationName(name);
  const keys = new Set<string>();
  if (folded) keys.add(folded);
  if (name.startsWith('磁浮')) {
    const short = foldStationName(name.slice(2));
    if (short) keys.add(short);
  }
  return [...keys];
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
 * canonical id slug and the AMap / Baidu name fragments. An unknown official
 * line still gets a usable config derived from its own name.
 */
function configFor(official: CsmtrLine): ChangshaLineConfig {
  const known = LINE_CONFIG_BY_OFFICIAL_CODE.get(official.code);
  if (known) return known;
  const short = official.name.replace(/号线$/, '') || String(official.code);
  return {
    short,
    name: official.name,
    slug: asciiSlug(official.name) || String(official.code),
    mode: 'metro',
    amapName: official.name,
    baiduNameHint: `轨道交通${official.name}`
  };
}

/** Split the operator's CamelCase pinyin into words (see `core`). */
function splitCamelPinyin(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s || !/^[A-Za-z]/.test(s)) return '';
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const prev = i > 0 ? s[i - 1]! : '';
    const next = i + 1 < s.length ? s[i + 1]! : '';
    const startsWord =
      i > 0 &&
      /[A-Z]/.test(ch) &&
      (/[a-z0-9]/.test(prev) || (/[A-Z]/.test(prev) && /[a-z]/.test(next)));
    if (startsWord) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out.filter(Boolean).join(' ');
}

export interface NormalizeInput {
  sources: ChangshaSources;
}

export function normalizeChangsha(input: NormalizeInput): ChangshaCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);

  type Phys = {
    id: string;
    /** The corrected, canonical Chinese name. */
    zh: string;
    /** Every spelling this station is known by (official + AMap). */
    keys: Set<string>;
    /** Official per-line station ids of this physical station. */
    officialIds: string[];
    /** Official per-line station codes of this physical station. */
    officialCodes: string[];
    /** CamelCase pinyin as published by AMap. */
    camelPinyin?: string;
    /** Word-separated pinyin, used as the romanised label fallback. */
    pinyin?: string;
    /** AMap's English name, used when Wikidata has none. */
    amapNameEn?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    lines: Set<string>;
    /** Official interchange flag (`huancheng`). */
    interchange: boolean;
    /** Exit description. */
    service?: string;
    /** Bus connections per exit. */
    bus?: string;
  };

  const physByName = new Map<string, Phys>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const usedSlugs = new Set<string>();

  /** Stable slug for a physical station, unique across the network. */
  const slugFor = (camel: string | undefined, zh: string, code: string): string => {
    const words = splitCamelPinyin(camel);
    const base = (words ? asciiSlug(words) : '') || asciiSlug(zh) || `station-${code}`;
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    const disambiguated = `${base}-${code}`;
    usedSlugs.add(disambiguated);
    return disambiguated;
  };

  /** The canonical name of an official station (decodes entities, corrects the feed). */
  const correctedName = (raw: string): string => {
    const decoded = decodeHtmlEntities(raw);
    return OFFICIAL_NAME_OVERRIDES[decoded] ?? decoded;
  };

  const ensurePhys = (station: CsmtrStation, lineId: string): Phys | undefined => {
    const rawName = station.stationName.trim();
    if (!rawName) return undefined;
    const zh = correctedName(rawName);
    const key = foldStationName(zh);
    let phys = physByName.get(key);
    if (!phys) {
      const amap = amapStationIndex.get(foldStationName(zh));
      const camel = String(amap?.sp ?? '').trim() || undefined;
      const pinyin = camel ? splitCamelPinyin(camel) : undefined;
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      // AMap's English spelling wins over the hand-maintained override only
      // when it does not need correcting (the maglev's airport station is
      // published as "Huanghua Airport Maglev Station", which belongs to
      // Line 6's airport, not to the maglev).
      const amapEn = String(amap?.multilang?.n?.en ?? '').trim();
      const amapNameEn = ENGLISH_NAME_OVERRIDES[zh] ?? (amapEn || undefined);
      phys = {
        id: `${NETWORK_ID}-${slugFor(camel, zh, String(station.stationNo))}`,
        zh,
        keys: new Set(nameKeys(zh)),
        officialIds: [],
        officialCodes: [],
        camelPinyin: camel,
        pinyin,
        amapNameEn,
        location: loc,
        schematic: pix,
        lines: new Set(),
        interchange: false,
        service: station.service?.trim() || undefined,
        bus: station.bus?.trim() || undefined
      };
      physByName.set(key, phys);
      if (loc) officialLocations.set(phys.id, { ...loc, crs: 'gcj02' });
    }
    phys.keys.add(foldStationName(rawName));
    const amapEntry = amapStationIndex.get(foldStationName(zh));
    if (amapEntry) {
      const amapName = amapEntry.n;
      if (amapName) {
        for (const k of nameKeys(amapName)) phys.keys.add(k);
      }
      const amapEn = String(amapEntry.multilang?.n?.en ?? '').trim();
      if (!phys.amapNameEn) {
        phys.amapNameEn = ENGLISH_NAME_OVERRIDES[zh] ?? (amapEn || undefined);
      }
    }
    phys.officialIds.push(station.id);
    phys.officialCodes.push(String(station.stationNo));
    phys.lines.add(lineId);
    if (station.huancheng === '1') phys.interchange = true;
    if (!phys.service && station.service?.trim()) phys.service = station.service.trim();
    if (!phys.bus && station.bus?.trim()) phys.bus = station.bus.trim();
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { official: CsmtrLine; cfg: ChangshaLineConfig }[] = [];

  const officialLines = [...sources.lines].sort((a, b) => a.code - b.code);
  for (const official of officialLines) {
    const cfg = configFor(official);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    const amap = amapLineIndex.get(cfg.amapName);
    const nameEn =
      amap?.multilang?.ln?.en ?? deriveLineEnglishName(official.name) ?? `Line ${cfg.short}`;
    const short = resolveLineShortName(official.name, cfg.short);
    const line: LineEncoded = {
      id,
      name: official.name,
      names: { zh: official.name, en: nameEn },
      aliases: [],
      color: hexToCss(amap?.cl),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: CSMTR_SOURCE, id: official.id },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.id,
        official_line_code: official.code,
        official_start_name: official.startName,
        official_end_name: official.endName,
        station_count: official.station_count,
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
  const stationNamesByLineId = new Map<string, string[]>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  /** Canonical stop id → canonical station id. */
  const stationIdByStopId = new Map<string, string>();
  /** Canonical stop id → official per-line station code. */
  const stationCodeByStopId = new Map<string, string>();
  /** Per line: every name key → the stop that carries it. */
  const stopIdByLineNameKey = new Map<string, Map<string, string>>();
  /** Per line: the line's stops in official order. */
  const lineStopOrder = new Map<string, string[]>();
  /** Per line: the operator's raw line-stop rows (needed for the timetables). */
  const officialStationsByLineId = new Map<string, CsmtrStation[]>();

  for (const { official, cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const officialStations = sources.stationsByLine.get(official.id) ?? [];
    if (officialStations.length < 2) {
      console.log(`  ${cfg.name}: only ${officialStations.length} stops, skipped`);
      continue;
    }

    const lineStops: StopEncoded[] = [];
    const linePhys: Phys[] = [];
    const nameKeysOfLine = new Map<string, string>();

    for (let i = 0; i < officialStations.length; i++) {
      const station = officialStations[i]!;
      const phys = ensurePhys(station, lineId);
      if (!phys) continue;

      const stopId = `${phys.id}-${cfg.short}`;
      stationIdByStopId.set(stopId, phys.id);
      stationCodeByStopId.set(stopId, String(station.stationNo));
      for (const k of phys.keys) if (!nameKeysOfLine.has(k)) nameKeysOfLine.set(k, stopId);

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
        source_id: String(station.stationNo),
        extras: {
          line_short_name: cfg.short,
          official_station_id: station.id,
          official_line_id: official.id,
          official_station_no: station.stationNo,
          official_interchange: station.huancheng === '1'
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
    stopIdByLineNameKey.set(lineId, nameKeysOfLine);
    lineStopOrder.set(
      lineId,
      lineStops.map((s) => s.id)
    );
    officialStationsByLineId.set(lineId, officialStations);

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
      source_ids: [{ source: CSMTR_SOURCE, id: official.id }],
      extras: {
        line_short_name: cfg.short,
        origin_name: linePhys[0]?.zh,
        terminal_name: linePhys[linePhys.length - 1]?.zh,
        pattern_note:
          '官方发布的单一交路：3 号线的西环线段（山塘—湘潭北站）与主线贯通，红桥方向为同一条走廊上的折返交路，按仓库的交路模型发布为主交路上的第三个终点（destination_stop_id），不另建交路。'
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
        source_id: CSMTR_SOURCE
      });
    }
  }

  // ---- Timetables -----------------------------------------------------------
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  for (const { cfg } of lineCfgs) {
    const lineId = `${NETWORK_ID}-line-${cfg.slug}`;
    const lineStops = stopsByLineId.get(lineId);
    const nameKeysOfLine = stopIdByLineNameKey.get(lineId);
    if (!lineStops || !nameKeysOfLine) continue;

    const primaryPattern = patterns.find((p) => p.line_id === lineId && p.is_primary);
    if (!primaryPattern) continue;

    /**
     * Resolve the destination a `times` label names.
     *
     * The label uses the operator's short wording — `金盆丘` for the station
     * 金盆丘(铜官窑巴士站), `机场` / `高铁` for the maglev's stations, `湘潭北`
     * for 湘潭北站 — so an exact key match is tried first, then a unique
     * prefix match, then a unique suffix match.
     */
    const resolveDestination = (label: string): string | undefined => {
      const folded = foldStationName(label);
      if (!folded) return undefined;
      const exact = nameKeysOfLine.get(folded);
      if (exact) return exact;
      const prefixed = [...nameKeysOfLine.entries()].filter(([key]) => key.startsWith(folded));
      if (prefixed.length === 1) return prefixed[0]![1];
      const suffixed = [...nameKeysOfLine.entries()].filter(([key]) => key.endsWith(folded));
      if (suffixed.length === 1) return suffixed[0]![1];
      return undefined;
    };

    for (const station of officialStationsByLineId.get(lineId) ?? []) {
      const entries = parseOfficialTimes(station.times);
      if (entries.length === 0) continue;

      const phys = physByName.get(foldStationName(correctedName(station.stationName)));
      if (!phys) continue;
      const stopId = `${phys.id}-${cfg.short}`;
      if (!lineStops.some((s) => s.id === stopId)) continue;

      // Group the published rows of this station by their destination.
      const byDestination = new Map<string, typeof entries>();
      for (const entry of entries) {
        const list = byDestination.get(entry.destinationLabel) ?? [];
        list.push(entry);
        byDestination.set(entry.destinationLabel, list);
      }

      for (const [destinationLabel, directionEntries] of byDestination) {
        const destinationStopId = resolveDestination(destinationLabel);
        if (!destinationStopId) {
          console.log(
            `  ${cfg.name} ${station.stationName}: unknown destination "${destinationLabel}", skipped`
          );
          continue;
        }
        const direction: ResolvedDirection = {
          destinationStopId,
          destinationStationId: stationIdByStopId.get(destinationStopId) ?? '',
          destinationLabel,
          originStopId: stopId,
          directionLabel: directionEntries[0]!.directionOnly
            ? `往${destinationLabel}方向`
            : `${destinationLabel}方向`,
          entries: directionEntries
        };
        const records = buildDirectionTimetables(direction, {
          lineId,
          patternId: primaryPattern.id,
          stationIdByStopId,
          stationCodeByStationId: new Map(
            [...stationIdByStopId].map(([sid, stid]) => [stid, stationCodeByStopId.get(sid) ?? ''])
          ),
          sourceId: CSMTR_SOURCE
        });
        for (const rec of records) {
          if (ttIds.has(rec.id)) continue;
          ttIds.add(rec.id);
          timetables.push(rec);
        }
      }
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  const interchangeLines = new Map<string, Set<string>>();
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
      // English names come from Wikidata (core); the AMap spelling and the
      // operator's pinyin are the deterministic fallbacks.
      names: { zh: phys.zh, en: '' },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: phys.officialIds.map((id) => ({ source: CSMTR_SOURCE, id })),
      extras: {
        pinyin: phys.pinyin,
        camel_pinyin: phys.camelPinyin,
        amap_name_en: phys.amapNameEn,
        official_station_ids: phys.officialIds,
        official_codes: phys.officialCodes,
        lines: servedLines,
        official_interchange: phys.interchange,
        exits: phys.service,
        bus_connections: phys.bus,
        location_source: 'amap'
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '长沙地铁',
    names: { zh: '长沙地铁', en: 'Changsha Metro' },
    city: placeholderCity('CN-4301'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 600 },
    notes:
      '拓扑（线路、站序、官方线内站码）、逐站逐方向首末班、换乘标记、车站出入口与逐出口公交接驳均来自长沙轨道交通集团官网 www.hncsmtr.com 的 Creator CMS 接口（findAllDtLineData.page / findDtStationData.page / getDtStationInfoById.page）。官网本身不提供经纬度与英文名：坐标、线色、英文名与示意图像素取自 AMap Subway 4301（GCJ-02，与官方站序逐线一致）。英文名以 AMap 发布的译名优先（Wuyi Square、Beichen Delta），Wikidata 补缺——Wikidata 对长沙各站的英文标签只是未翻译的拼音（Wu Yi Guang Chang），质量不如 AMap，故顺序与 cn-hongkong 一致。区间运行时间、区间里程与换乘步行取自百度路径规划 direction/v2/transit（官方均不公布）。票价按《长沙市轨道交通集团票务规则》第四条的里程分段计价公式计算（起步 2 元 6 公里，递远递减 5/7/9 公里一档），计价里程取百度逐相邻站对乘车里程的 Dijkstra 最短路；磁浮快线不在该规则适用范围内（《票务规则》第二条明写"不含长沙磁浮快线"），相关 OD 对在 fares.json 中为 null。3 号线同时发布广生、红桥、湘潭北三个终点，红桥为同一走廊上的折返交路，按仓库的交路模型发布为主交路上的第三个终点而非另建交路。磁浮快线另发布工作日与双休日两套时刻，落盘为 7 元素星期数组。在建的 4 号线北延段、6 号线东延段、7 号线一期、S2 东延线与 Y1 大王山云巴未建模。官方 CMS 的 huancheng 标记不可靠（把 3 号线烈士公园东、6 号线中塘标为换乘站，却漏标了长沙火车站与侯家塘），换乘关系一律以官方线-站表推导，并与 AMap 的换乘标记逐站一致（19 座换乘站）。'
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
