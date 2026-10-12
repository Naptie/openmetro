import {
  asciiSlug,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  isUsableEnglish,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  parsePixel,
  parseSlCoord,
  pinyinToEnglish,
  placeholderCity,
  readableSlug,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, UrumqiSources } from './fetch.js';
import { APM_SERVICE_NOTE, SCHEDULE_NOTE, URUMQI_LINES } from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-urumqi';

const AMAP_SOURCE = 'amap-subway-6501';
const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface UrumqiCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

function resolveEnglishName(st: AmapStation): string | undefined {
  const multilang = String(st.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(multilang);
  const en = String(st.en ?? '').trim();
  if (isUsableEnglish(en)) return titleCaseRoman(en);
  const fromPinyin = pinyinToEnglish(String(st.sp ?? ''));
  if (fromPinyin) return fromPinyin;
  // Wikidata fillStationEnglishNames in run.ts supplies the rest — never invent names.
  return undefined;
}

function titleCaseRoman(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function lineIdOf(slug: string): string {
  return `${NETWORK_ID}-line-${readableSlug(slug) || asciiSlug(slug)}`;
}

function stopIdOf(stationId: string, slug: string): string {
  return `${stationId}-${slug}`;
}

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) out.set(ln, line);
  }
  return out;
}

export function normalizeUrumqi(
  input: UrumqiSources,
  harvestedRows: Map<string, HarvestedStationTimes[]>
): UrumqiCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordBySlug = new Map<string, LineEncoded>();
  const lineIdBySlug = new Map<string, string>();

  for (const cfg of URUMQI_LINES) {
    const lineId = lineIdOf(cfg.slug);
    lineIdBySlug.set(cfg.slug, lineId);
    const amap = amapByName.get(cfg.amapName);
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    const isApm = cfg.slug === 'apm';
    lineRecordBySlug.set(cfg.slug, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: amap?.kn && amap.kn !== cfg.name ? [String(amap.kn)] : [],
      color: hexToCss(amap?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: AMAP_SOURCE, id: cfg.amapName },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: 'source',
        amap_color: amap?.cl,
        amap_name: amap?.ln,
        baidu_vehicle_name: cfg.baiduNameHint,
        ...(isApm
          ? { service_note: APM_SERVICE_NOTE }
          : { service_note: SCHEDULE_NOTE, fare_policy: 'mileage' })
      }
    });
  }

  type Phys = {
    id: string;
    zh: string;
    en: string;
    lineNames: Set<string>;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
  };
  const physByFold = new Map<string, Phys>();
  const amapStationByFold = new Map<string, AmapStation>();
  for (const line of input.amapSubway.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !amapStationByFold.has(foldStationName(n))) {
        amapStationByFold.set(foldStationName(n), st);
      }
    }
  }

  const ensurePhys = (zhRaw: string): Phys => {
    const zh = zhRaw.trim();
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    if (!phys) {
      const amap = amapStationByFold.get(key);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(amap ?? {}) ?? '';
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
        zh,
        en,
        lineNames: new Set(),
        location: parseSlCoord(amap?.sl),
        schematic: parsePixel(amap?.p),
        pinyin,
        poiid: amap?.poiid || undefined
      };
      physByFold.set(key, phys);
    }
    return phys;
  };

  const stopById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const pushSegment = (
    lineId: string,
    a: StopEncoded,
    b: StopEncoded,
    source: string
  ): SegmentEncoded => {
    const key = [a.id, b.id].sort().join('|');
    const existing = segments.find((s) => [s.from_stop_id, s.to_stop_id].sort().join('|') === key);
    if (existing) return existing;
    const seg: SegmentEncoded = {
      id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
      line_id: lineId,
      from_stop_id: a.id,
      to_stop_id: b.id,
      from_station_id: a.station_id,
      to_station_id: b.station_id,
      direction: 'both',
      source_id: source
    };
    segments.push(seg);
    return seg;
  };

  for (const cfg of URUMQI_LINES) {
    const slug = cfg.slug;
    const lineId = lineIdBySlug.get(slug)!;
    const amap = amapByName.get(cfg.amapName);
    const amapStations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (amapStations.length < 2) {
      throw new Error(`AMap station list empty for ${cfg.amapName}`);
    }

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    for (let i = 0; i < amapStations.length; i++) {
      const phys = ensurePhys(amapStations[i]!);
      phys.lineNames.add(cfg.name);
      const id = stopIdOf(phys.id, slug);
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === amapStations.length - 1,
          source_id: amapStations[i]!,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: cfg.short,
            amap_order: i
          }
        });
      }
      physList.push(phys);
      stopIds.push(id);
    }

    const primaryName = `${amapStations[0]} → ${amapStations[amapStations.length - 1]}`;
    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(slug)}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: primaryName,
      names: {
        zh: `${amapStations[0]}→${amapStations[amapStations.length - 1]}`,
        en: `${amapStations[0]} to ${amapStations[amapStations.length - 1]}`
      },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: { line_short_name: cfg.short }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!, AMAP_SOURCE);
    }

    // First/last trains from Baidu Direction v2 (AMap station order).
    const rows = harvestedRows.get(slug);
    if (!rows?.length) continue;
    const destDown = stopIds[stopIds.length - 1]!;
    const destUp = stopIds[0]!;

    for (let i = 0; i < amapStations.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const phys = physList[i]!;
      const stopId = stopIds[i]!;
      const downFirst = weekArray(row.downFirst ?? null);
      const downLast = weekArray(row.downLast ?? null);
      const upFirst = weekArray(row.upFirst ?? null);
      const upLast = weekArray(row.upLast ?? null);

      if (downFirst.length || downLast.length) {
        const id = `${NETWORK_ID}-${phys.id}-${slug}-down`;
        if (!ttIds.has(id)) {
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            source_id: TT_SOURCE_BAIDU,
            destination_stop_id: destDown,
            origin_stop_id: destUp,
            pattern_id: patternId,
            direction_type: 'linear',
            direction_label: 'down',
            first_train: downFirst,
            last_train: downLast,
            extras: { line_short_name: cfg.short, calendar: 'all_days' }
          });
        }
      }
      if (upFirst.length || upLast.length) {
        const id = `${NETWORK_ID}-${phys.id}-${slug}-up`;
        if (!ttIds.has(id)) {
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            source_id: TT_SOURCE_BAIDU,
            destination_stop_id: destUp,
            origin_stop_id: destDown,
            pattern_id: patternId,
            direction_type: 'linear',
            direction_label: 'up',
            first_train: upFirst,
            last_train: upLast,
            extras: { line_short_name: cfg.short, calendar: 'all_days' }
          });
        }
      }
    }
  }

  const stops: StopEncoded[] = [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id));

  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  for (const phys of physByFold.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (location) officialLocations.set(phys.id, location);
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en || phys.zh },
      location,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [
        { source: AMAP_SOURCE, id: phys.zh },
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        lines: [...phys.lineNames],
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived'
      }
    });
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '乌鲁木齐地铁',
    names: { zh: '乌鲁木齐地铁', en: 'Ürümqi Metro' },
    city: placeholderCity('CN-6501'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/坐标/英文名来自 AMap Subway（官网仅发布图片版线网图、首末班车时刻表与票价表，无结构化接口，未做 OCR）；' +
      '首末班车、区间耗时/距离与 OD 票价实时查询百度路径规划（direction/v2/transit），并经腾讯地图（direction/v1/transit）独立交叉核验一致。' +
      '运营时刻口径：常规运行图为每年10月8日至次年6月30日；夏季旅游旺季运营方临时延长运营约1小时（2026年周期为07-01至10-07），' +
      '延长期间规划器末班数据早于实际约1小时、恢复常规图后一致（2026-10-12 核验：规划器末班 23:30 与 10-08 切换公告吻合；' +
      '官网时刻表图片当时仍为旺季版本），请以运营方公告为准；' +
      '机场捷运为 2 号线一期先期开通段（T4 航站楼捷运，2025-04-17 开通），其 OD 票价运营方未公布（票价矩阵记 null）。'
  };

  return {
    network,
    lines: [...lineRecordBySlug.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: filteredTimetables,
    officialLocations
  };
}

/** Ürümqi runs one all-days schedule; the 7-element array repeats the value. */
function weekArray(value: string | null | undefined): string[] {
  const v = value ?? undefined;
  if (!v) return [];
  return [v, v, v, v, v, v, v];
}
