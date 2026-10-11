/**
 * Canonical normalization for cn-fuzhou.
 *
 * Topology and timetables both come from the official `/services/schedule`
 * island props (six lines, per-station per-direction first/last trains,
 * official CMS stop ids); coordinates/romanisation/schematic join from the
 * AMap subway dataset by folded station name. All six lines are linear, so
 * every pattern is a single primary chain.
 *
 * Physical-station identity folds the line-disambiguation suffix the operator
 * appends on cross-line maps (`三叉街（滨海快线）` is the same physical station
 * as line 1's `三叉街`); the raw official name is preserved on the stop.
 */
import {
  asciiSlug,
  cleanTime,
  deriveLineEnglishName,
  foldStationName,
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
  type TimetableEncoded,
  titleCaseRoman
} from '@openmetro/core';
import type { FuzSiteLine, FuzSources } from './fetch.js';
import { FUZHOU_LINES } from './lines.js';

const NETWORK_ID = 'cn-fuzhou';

const SITE_SOURCE = 'fzmtr-services-schedule';
const AMAP_SOURCE = 'amap-subway-3501';

export interface FuzhouCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

interface AmapStationFull {
  n?: string;
  en?: string;
  sp?: string;
  sl?: string;
  p?: string;
  poiid?: string;
  multilang?: { n?: Record<string, string> };
}

function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/**
 * `三叉街（滨海快线）` → `三叉街`: the operator suffixes cross-line names on
 * through-map contexts; the suffix never names a different physical station.
 */
function physicalStationName(zh: string): string {
  const stripped = zh.replace(/[（(][^（）()]*[）)]$/, '').trim();
  return stripped || zh.trim();
}

function resolveEnglishName(st: AmapStationFull | undefined): string | undefined {
  const multilang = String(st?.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(multilang);
  const en = String(st?.en ?? '').trim();
  if (isUsableEnglish(en)) return titleCaseRoman(en);
  const fromPinyin = pinyinToEnglish(st?.sp);
  if (fromPinyin) return fromPinyin;
  // fillStationEnglishNames (Wikidata) supplies the rest — never invent names.
  return undefined;
}

/** `次日00:23` → `00:23` (normalizeTimetableTimes shifts past-midnight to 24:xx). */
function parseSiteTime(raw: string | undefined): string | undefined {
  const t = (raw ?? '').replace(/^次日/, '').trim();
  if (!t) return undefined;
  // CMS occasionally carries seconds (`06:37:00`).
  const hhmm = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(t) ? t.slice(0, 5) : t;
  return cleanTime(hhmm);
}

function weekArrayAllDays(time: string | undefined): string[] {
  return time ? [time, time, time, time, time, time, time] : [];
}

export function normalizeFuzhou(input: FuzSources): FuzhouCanonical {
  const siteByName = new Map<string, FuzSiteLine>();
  for (const line of input.siteLines) {
    if (line.name) siteByName.set(line.name.trim(), line);
  }
  const amapByName = new Map<string, AmapStationFull[]>();
  for (const line of input.amapSubway.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) amapByName.set(ln, (line.st ?? []) as AmapStationFull[]);
  }
  const amapColorByName = new Map<string, string | undefined>(
    (input.amapSubway.l ?? []).map((l) => [String(l.ln ?? ''), hexToCss(l.cl)])
  );

  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();
  const siteLineByShort = new Map<string, FuzSiteLine>();

  for (const cfg of FUZHOU_LINES) {
    const site = siteByName.get(cfg.name);
    if (!site) throw new Error(`official schedule has no data for ${cfg.name}`);
    const lineId = lineIdOf(cfg.short);
    lineIdByShort.set(cfg.short, lineId);
    siteLineByShort.set(cfg.short, site);
    const amapColor = amapColorByName.get(cfg.amapName);
    const color = hexToCss(site.color) ?? amapColor;
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecordByShort.set(cfg.short, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: [],
      color,
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [{ source: SITE_SOURCE, id: site.id }],
      extras: {
        names_source: 'source',
        official_color: site.color,
        amap_color: amapColor?.replace('#', ''),
        peak_hour: site.peakHour || undefined,
        off_peak_hour: site.offPeakHour || undefined,
        low_peak_hour: site.lowPeakHour || undefined,
        ...(site.isFast === '1' ? { express_line: true } : {})
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
  const amapStationByFold = new Map<string, AmapStationFull>();
  for (const sts of amapByName.values()) {
    for (const st of sts) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      // Prefer the plain (non-suffixed) AMap entry for a folded name: line 1's
      // 三叉街 precedes the F1 duplicate in document order.
      const key = foldStationName(physicalStationName(n));
      if (!amapStationByFold.has(key)) amapStationByFold.set(key, st);
    }
  }

  const ensurePhys = (zhRaw: string): Phys => {
    const zh = physicalStationName(zhRaw.trim());
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    if (!phys) {
      const amap = amapStationByFold.get(key);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(amap) ?? '';
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
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const pushSegment = (lineId: string, a: StopEncoded, b: StopEncoded, source: string): void => {
    const key = [a.id, b.id].sort().join('|');
    if (segments.some((s) => [s.from_stop_id, s.to_stop_id].sort().join('|') === key)) return;
    segments.push({
      id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
      line_id: lineId,
      from_stop_id: a.id,
      to_stop_id: b.id,
      from_station_id: a.station_id,
      to_station_id: b.station_id,
      direction: 'both',
      source_id: source
    });
  };

  for (const cfg of FUZHOU_LINES) {
    const short = cfg.short;
    const lineId = lineIdByShort.get(short)!;
    const site = siteLineByShort.get(short)!;
    const rows = [...(site.stationList ?? [])].sort(
      (a, b) => Number(a.sortNum) - Number(b.sortNum)
    );
    if (rows.length < 2) throw new Error(`${cfg.name}: fewer than 2 station rows`);

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    rows.forEach((row, i) => {
      const rawName = row.name?.trim();
      if (!rawName) throw new Error(`${cfg.name}: station row ${i} has no name`);
      const phys = ensurePhys(rawName);
      phys.lineNames.add(cfg.name);
      const id = `${phys.id}-${short}`;
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === rows.length - 1,
          source_id: row.id || undefined,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            official_name: rawName !== phys.zh ? rawName : undefined
          }
        });
      }
      physList.push(phys);
      stopIds.push(id);
    });

    const firstZh = physList[0]!.zh;
    const lastZh = physList[physList.length - 1]!.zh;
    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(short) || readableSlug(short)}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${firstZh} → ${lastZh}`,
      names: { zh: `${firstZh}→${lastZh}`, en: `${firstZh} to ${lastZh}` },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: SITE_SOURCE, id: site.id }],
      extras: { line_short_name: short }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!, SITE_SOURCE);
    }

    // First/last trains: the row labels each direction with its terminus
    // (`往三江口`); resolve that label to the line's terminal stop.
    const stopIdByFold = new Map<string, string>();
    rows.forEach((row, i) => {
      stopIdByFold.set(foldStationName(physicalStationName(row.name ?? '')), stopIds[i]!);
    });
    const resolveDirectionTarget = (label: string): { stopId: string; label: string } => {
      const target = label.replace(/^往/, '').trim();
      const stopId = stopIdByFold.get(foldStationName(target));
      if (!stopId) throw new Error(`${cfg.name}: direction label ${label} is not a line stop`);
      return { stopId, label: target };
    };

    rows.forEach((row, i) => {
      const phys = physList[i]!;
      const stopId = stopIds[i]!;
      for (const dir of [
        {
          label: row.startDirection,
          first: parseSiteTime(row.startDirectionFirstTime),
          last: parseSiteTime(row.startDirectionLastTime),
          fastText: row.fastFirstTimeText
        },
        {
          label: row.endDirection,
          first: parseSiteTime(row.flipDirectionFirstTime),
          last: parseSiteTime(row.flipDirectionLastTime),
          fastText: row.fastEndTimeText
        }
      ]) {
        const firstTrain = weekArrayAllDays(dir.first);
        const lastTrain = weekArrayAllDays(dir.last);
        if (!firstTrain.length && !lastTrain.length) continue;
        const { stopId: destStopId, label: destName } = resolveDirectionTarget(dir.label ?? '');
        const dirKey = destStopId === stopIds[stopIds.length - 1] ? 'down' : 'up';
        const id = `${NETWORK_ID}-${phys.id}-${short}-${dirKey}`;
        if (timetables.some((t) => t.id === id)) continue;
        timetables.push({
          id,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          source_id: SITE_SOURCE,
          destination_stop_id: destStopId,
          origin_stop_id: destStopId === stopIds[0] ? stopIds[stopIds.length - 1]! : stopIds[0]!,
          pattern_id: patternId,
          direction_type: 'linear',
          direction_label: dirKey,
          first_train: firstTrain,
          last_train: lastTrain,
          extras: {
            line_short_name: short,
            calendar: 'all_days',
            destination_name: destName,
            ...(dir.fastText ? { express_first_text: dir.fastText } : {})
          }
        });
      }
    });
  }

  const stops: StopEncoded[] = [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const siteExtrasByFold = new Map<string, { channelInfo: string; map: string; qrCode: string }>();
  for (const site of input.siteLines) {
    for (const row of site.stationList ?? []) {
      const key = foldStationName(physicalStationName(row.name ?? ''));
      if (!siteExtrasByFold.has(key)) {
        siteExtrasByFold.set(key, {
          channelInfo: row.channelInfo ?? '',
          map: row.map ?? '',
          qrCode: row.qrCode ?? ''
        });
      }
    }
  }
  const stations: StationEncoded[] = [];
  for (const phys of physByFold.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (location) officialLocations.set(phys.id, location);
    const site = siteExtrasByFold.get(foldStationName(phys.zh));
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
        { source: SITE_SOURCE, id: phys.zh },
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        lines: [...phys.lineNames],
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived',
        official_exits: site ? decodeHtmlEntities(site.channelInfo) || undefined : undefined,
        official_sketch_url: site?.map || undefined,
        official_bus_qr_url: site?.qrCode || undefined
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '福州地铁',
    names: { zh: '福州地铁', en: 'Fuzhou Metro' },
    city: placeholderCity('CN-3501'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与首末班车来自官网 fzmtr.com /services/schedule 页内嵌的官方结构化数据（每站每方向首末班、官方站序与 CMS 站点 id，含 2025-09 开通的滨海快线及其大站快车首末班文本）；票价来自官网票价线路查询接口 /api/system/way/list（官方预计算 OD 表）；坐标/拼音/站名罗马化取自 AMap Subway（官网 CMS 无坐标与英文名），英文名由 AMap multilang 与 Wikidata 补全；区间运行时间由首末班车链推导，缺失项由百度路径规划 gapfill 层补齐。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: timetables,
    officialLocations
  };
}
