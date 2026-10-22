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
  type TimetableEncoded
} from '@openmetro/core';
import type {
  AmapLine,
  AmapStation,
  AmapSubwayDoc,
  ShijiazhuangSources,
  SjzStation
} from './fetch.js';
import { LINE_CONFIG_BY_OFFICIAL_ID, type ShijiazhuangLineConfig } from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-shijiazhuang';
const SJZ_SOURCE = 'sjzmetro-api';
const AMAP_SOURCE = 'amap-subway-1301';

export interface ShijiazhuangCanonical {
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
 * planner's vehicle-name fragment and the canonical id slug. An unknown
 * official line still gets a usable config derived from its own name.
 */
function configFor(
  officialId: number,
  officialName: string,
  byName: Map<string, ShijiazhuangLineConfig>
): ShijiazhuangLineConfig {
  const known = byName.get(officialName.trim());
  if (known) return known;
  const byId = LINE_CONFIG_BY_OFFICIAL_ID.get(officialId);
  if (byId) return byId;
  return {
    short: officialName.replace(/号线$/, '') || String(officialId),
    name: officialName,
    slug: asciiSlug(officialName) || String(officialId),
    mode: 'metro',
    baiduNameHint: `地铁${officialName}`
  };
}

export interface NormalizeInput {
  sources: ShijiazhuangSources;
  /** Per official line id: the harvested per-station first/last trains. */
  harvestedTimes?: Map<number, HarvestedStationTimes[]>;
}

export function normalizeShijiazhuang(input: NormalizeInput): ShijiazhuangCanonical {
  const { sources } = input;
  const amapLineIndex = amapLineByName(sources.amap);
  const amapStationIndex = amapStationByFold(sources.amap);
  const cfgByName = new Map(
    [...LINE_CONFIG_BY_OFFICIAL_ID.values()].map((c) => [c.name, c] as const)
  );

  type Phys = {
    id: string;
    officialId: number;
    zh: string;
    en: string;
    pinyin?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    sourceIds: Set<string>;
  };

  const physByOfficialId = new Map<number, Phys>();
  const physByStationId = new Map<string, Phys>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensurePhys = (station: SjzStation): Phys | undefined => {
    const zh = station.station_name.trim();
    if (!zh) return undefined;
    let phys = physByOfficialId.get(station.station_id);
    if (!phys) {
      const amap = amapStationIndex.get(foldStationName(zh));
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = pinyinToEnglish(pinyin) ?? '';
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
        officialId: station.station_id,
        zh,
        en,
        pinyin,
        location: loc,
        schematic: pix,
        sourceIds: new Set()
      };
      physByOfficialId.set(station.station_id, phys);
      physByStationId.set(phys.id, phys);
      if (loc) officialLocations.set(phys.id, { ...loc, crs: 'gcj02' });
    }
    phys.sourceIds.add(String(station.station_id));
    return phys;
  };

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const lineCfgs: { officialId: number; cfg: ShijiazhuangLineConfig }[] = [];

  for (const official of [...sources.lines].sort((a, b) => a.line_id - b.line_id)) {
    const cfg = configFor(official.line_id, official.line_name, cfgByName);
    const id = `${NETWORK_ID}-line-${cfg.slug}`;
    const amap = amapLineIndex.get(official.line_name);
    const nameEn = deriveLineEnglishName(official.line_name) ?? `Line ${cfg.short}`;
    const short = resolveLineShortName(official.line_name, cfg.short);
    const line: LineEncoded = {
      id,
      name: official.line_name,
      names: { zh: official.line_name, en: nameEn },
      aliases: [],
      color: hexToCss(official.color_code) ?? hexToCss(amap?.cl),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: Boolean(official.is_circle_line),
      source_ids: [
        { source: SJZ_SOURCE, id: String(official.line_id) },
        ...(amap?.li ? [{ source: AMAP_SOURCE, id: String(amap.li) }] : [])
      ],
      extras: {
        official_line_id: official.line_id,
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

    // The array order of the official response is the line order.
    // `order_on_line` is NOT usable: for a station that also serves another
    // line the feed reports the numbering of that station's primary line
    // (石家庄站 comes back as 5 on both Line 2 and Line 3, where it is really
    // Line 3's 10th stop).
    for (let i = 0; i < officialStations.length; i++) {
      const station = officialStations[i]!;
      const phys = ensurePhys(station);
      if (!phys) continue;

      // `transfer_id` names the OTHER line this station connects to.
      const otherLineId = station.transfer_id ? Number(station.transfer_id) : undefined;
      if (otherLineId != null && Number.isFinite(otherLineId)) {
        const set = interchangeLines.get(phys.id) ?? new Set<string>();
        set.add(lineId);
        interchangeLines.set(phys.id, set);
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
        source_id: String(station.station_id),
        extras: { line_short_name: cfg.short, official_station_id: station.station_id }
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
      source_ids: [{ source: SJZ_SOURCE, id: String(officialId) }],
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
        source_id: SJZ_SOURCE
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

    const rowByName = new Map(rows.map((r) => [r.stationName.trim(), r] as const));
    const pattern = patterns.find((p) => p.line_id === lineId);
    if (!pattern) continue;

    const firstStop = lineStops[0]!;
    const lastStop = lineStops[lineStops.length - 1]!;

    for (const stop of lineStops) {
      const station = physByStationId.get(stop.station_id);
      if (!station) continue;
      const row = rowByName.get(station.zh.trim());
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
        const id = `${NETWORK_ID}-${stop.station_id}-${cfg.short}-to-${asciiSlug(
          dir.destStop.station_id
        )}-primary`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        const destStation = physByStationId.get(dir.destStop.station_id);
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
          extras: {
            service: 'primary',
            direction: dir.label,
            destination_name: destStation?.zh,
            source_note:
              '逐站首末班取自百度路径规划 direction/v2/transit 的 detail.first_time/last_time（起站发车时刻），与官网公布的首末班车时刻表逐项一致；官网仅以图片发布该表，未做 OCR。'
          }
        });
      }
    }
  }

  // ---- Stations -------------------------------------------------------------
  const stations: StationEncoded[] = [];
  for (const phys of physByOfficialId.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (loc) officialLocations.set(phys.id, loc);
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: {
        zh: phys.zh,
        en: phys.en && /^[A-Za-z]/.test(phys.en) && !/[\u4e00-\u9fff]/.test(phys.en) ? phys.en : ''
      },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [...phys.sourceIds].map((id) => ({ source: SJZ_SOURCE, id })),
      extras: {
        pinyin: phys.pinyin,
        official_station_id: phys.officialId
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '石家庄地铁',
    names: { zh: '石家庄地铁', en: 'Shijiazhuang Metro' },
    city: placeholderCity('CN-1301'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/站序/换乘关系/线色来自官网 sjzmetro.cn /metro/lines.html 与 /metro/stations.html（站序取响应数组下标，官方 order_on_line 对换乘站有误；坐标字段恒为空）。坐标/拼音英文名来自 AMap Subway 1301。逐站首末班、区间时间距离、换乘步行与 OD 票价来自百度路径规划 direction/v2/transit：官网首末班车时刻表与票价表仅以图片发布，未做 OCR；官网 /metro/recommend.html 返回的是全线服务窗口而非逐站首末班，其票价字段恒为起步价 2 元，均不采用。工作日与双休日的逐站首末班差异仅存在于官网图片时刻表中，机器可读源无法区分，故此层只发布单一变体。三座换乘站的站厅步行在规划器中均为同一模型值（231 米 / 193 秒），非逐站实测。在建的 1 号线二/三期、4/5/6 号线一期无结构化站表，未建模。'
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
