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
import type { AmapLine, AmapStation, AmapSubwayDoc, QingdaoSources } from './fetch.js';
import { QINGDAO_LINES, STATION_EN_OVERRIDES } from './lines.js';
import { type HarvestedStationTimes, weekArray } from './timetables.js';

const NETWORK_ID = 'cn-qingdao';

const AMAP_SOURCE = 'amap-subway-3702';
const SITE_SOURCE = 'qdmetro-site';
const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface QingdaoCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

/** Strip a qualifier suffix (`四川路(轮渡)` → `四川路`) before folding. */
export function baseStationName(zh: string): string {
  return foldStationName(zh.replace(/[(（][^)）]*[)）]/g, ''));
}

function resolveEnglishName(st: AmapStation, zh: string): string | undefined {
  const override = STATION_EN_OVERRIDES[zh] ?? STATION_EN_OVERRIDES[baseStationName(zh)];
  if (override) return override;
  const multilang = String(st.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(multilang);
  const en = String(st.en ?? '').trim();
  if (isUsableEnglish(en)) return titleCaseRoman(en);
  const fromPinyin = pinyinToEnglish(String(st.sp ?? ''));
  if (fromPinyin) return fromPinyin;
  // Wikidata fillStationEnglishNames in run.ts supplies the rest — never invent names.
  return undefined;
}

/** AMap publishes station romanisations in ALL CAPS; prose case reads better. */
function titleCaseRoman(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) out.set(ln, line);
  }
  return out;
}

export function normalizeQingdao(
  input: QingdaoSources,
  harvestedRows: Map<string, HarvestedStationTimes[]>
): QingdaoCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();

  for (const cfg of QINGDAO_LINES) {
    const lineId = lineIdOf(cfg.short);
    lineIdByShort.set(cfg.short, lineId);
    const amap = amapByName.get(cfg.amapName);
    const siteStations = input.siteStations.byLine.get(cfg.siteLine) ?? [];
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecordByShort.set(cfg.short, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: cfg.aliases ?? [],
      color: hexToCss(amap?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: AMAP_SOURCE, id: cfg.amapName },
        { source: SITE_SOURCE, id: String(cfg.siteLine) },
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
        baidu_vehicle_name: cfg.baiduName
      }
    });
    if (siteStations.length === 0) {
      throw new Error(`official siteSearch returned no stations for ${cfg.name}`);
    }
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
      const en = resolveEnglishName(amap ?? {}, zh) ?? '';
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

  const pushSegment = (lineId: string, a: StopEncoded, b: StopEncoded): SegmentEncoded => {
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
      source_id: AMAP_SOURCE
    };
    segments.push(seg);
    return seg;
  };

  for (const cfg of QINGDAO_LINES) {
    const short = cfg.short;
    const lineId = lineIdByShort.get(short)!;
    const amap = amapByName.get(cfg.amapName);
    const siteStations = input.siteStations.byLine.get(cfg.siteLine) ?? [];
    const amapStations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (amapStations.length < 2) {
      throw new Error(`AMap station list empty for ${cfg.amapName}`);
    }

    // The operator siteSearch list is the official cross-check: every AMap
    // station must appear there (qualifier suffixes stripped on both sides).
    const siteByBase = new Map<string, { id: string; display: string }>();
    for (const s of siteStations) {
      const display = `${s.value}${s.text ?? ''}`;
      const key = baseStationName(display);
      if (!siteByBase.has(key)) siteByBase.set(key, { id: s.id, display });
    }
    const unmatched: string[] = [];
    for (const n of amapStations) {
      if (!siteByBase.has(baseStationName(n))) unmatched.push(n);
    }
    if (unmatched.length > 0) {
      throw new Error(
        `${cfg.name}: AMap stations absent from the official siteSearch list: ${unmatched.join(', ')}`
      );
    }

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    for (let i = 0; i < amapStations.length; i++) {
      const zh = amapStations[i]!;
      const phys = ensurePhys(zh);
      phys.lineNames.add(cfg.name);
      const id = stopIdOf(phys.id, short);
      if (!stopById.has(id)) {
        const site = siteByBase.get(baseStationName(zh))!;
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === amapStations.length - 1,
          source_id: site.id,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            amap_order: i,
            site_name: site.display,
            station_code: site.id
          }
        });
      }
      physList.push(phys);
      stopIds.push(id);
    }

    const primaryName = `${amapStations[0]} → ${amapStations[amapStations.length - 1]}`;
    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(short)}-primary`;
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
      source_ids: [
        { source: AMAP_SOURCE, id: cfg.amapName },
        { source: SITE_SOURCE, id: String(cfg.siteLine) }
      ],
      extras: { line_short_name: short }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!);
    }

    // First/last trains from Baidu Direction Lite (AMap station order).
    const rows = harvestedRows.get(short);
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
        const id = `${NETWORK_ID}-${phys.id}-${short}-down`;
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
            extras: { line_short_name: short, calendar: 'all_days' }
          });
        }
      }
      if (upFirst.length || upLast.length) {
        const id = `${NETWORK_ID}-${phys.id}-${short}-up`;
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
            extras: { line_short_name: short, calendar: 'all_days' }
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
    name: '青岛地铁',
    names: { zh: '青岛地铁', en: 'Qingdao Metro' },
    city: placeholderCity('CN-3702'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/坐标/英文名/示意图像素来自 AMap Subway（3702_drw_qingdao），并与官网查询系统（qd-metro.com/data/execute.php siteSearch）逐线站表交叉校验，官方逐线站号存于 stop extras.station_code；首末班来自百度路径规划（directionlite transit），每次同步实时查询（官网无机器可读时刻表，官方发布渠道为青岛地铁 APP/公众号，仅图片）；票价来自官网信息公开栏发布的《青岛地铁票价信息表.xlsx》全网 OD 矩阵，pjSearch 接口抽样校验；11/13 号线已更名蓝谷快线/西海岸快线，8 号线另有快速列车班次（本数据模型不含列车等级）。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: filteredTimetables,
    officialLocations
  };
}
