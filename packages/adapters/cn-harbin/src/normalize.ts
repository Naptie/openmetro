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
  placeholderCity,
  readableSlug,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, HarbinSources } from './fetch.js';
import { HARBIN_LINES, type HarbinLineConfig, SCHEDULE_NOTE } from './lines.js';

const NETWORK_ID = 'cn-harbin';

const AMAP_SOURCE = 'amap-subway-2301';
const TT_SOURCE_BAIDU = 'baidu-direction-v2-transit';

export interface HarbinStationTimes {
  stationName: string;
  /** Toward the last stop of the line order; on the loop, the inner ring. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first stop of the line order; on the loop, the outer ring. */
  upFirst?: string | null;
  upLast?: string | null;
}

export interface HarbinCanonical {
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

/**
 * Ordered station names per line, de-duplicated by the AMap physical-station id
 * (`si`).
 *
 * AMap repeats 镜泊路 inside Line 1 (identical `si`); the same `si` on two
 * different lines is *not* a duplicate — that is an interchange, and each
 * line keeps its own stop.
 */
export function orderedStationNames(line: AmapLine): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const st of line.st ?? []) {
    const n = String(st.n ?? '').trim();
    if (!n) continue;
    const key = String(st.si ?? n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function normalizeHarbin(
  input: HarbinSources,
  harvestedRows: Map<string, HarbinStationTimes[]>
): HarbinCanonical {
  const amapByName = new Map<string, AmapLine>();
  for (const l of input.amapSubway.l ?? []) {
    const ln = String(l.ln ?? '').trim();
    if (ln) amapByName.set(ln, l);
  }

  const lineRecordBySlug = new Map<string, LineEncoded>();
  const lineIdBySlug = new Map<string, string>();
  for (const cfg of HARBIN_LINES) {
    const lineId = lineIdOf(cfg.slug);
    lineIdBySlug.set(cfg.slug, lineId);
    const amap = amapByName.get(cfg.amapName);
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecordBySlug.set(cfg.slug, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: amap?.kn && amap.kn !== cfg.name ? [String(amap.kn)] : [],
      color: hexToCss(amap?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: cfg.loop,
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: {
        names_source: 'source',
        amap_color: amap?.cl,
        amap_name: amap?.ln,
        baidu_vehicle_name: cfg.baiduNameHint,
        service_note: SCHEDULE_NOTE,
        fare_policy: 'mileage'
      }
    });
  }

  type Phys = {
    id: string;
    si: string;
    zh: string;
    en: string;
    lineNames: Set<string>;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
  };
  const physBySi = new Map<string, Phys>();
  const amapStationBySi = new Map<string, AmapStation>();
  for (const line of input.amapSubway.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const si = String(st.si ?? n);
      if (!amapStationBySi.has(si)) amapStationBySi.set(si, st);
    }
  }

  const ensurePhys = (si: string, zhRaw: string): Phys => {
    const zh = zhRaw.trim();
    let phys = physBySi.get(si);
    if (!phys) {
      const amap = amapStationBySi.get(si);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(amap ?? {}) ?? '';
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
        si,
        zh,
        en,
        lineNames: new Set(),
        location: parseSlCoord(amap?.sl),
        schematic: parsePixel(amap?.p),
        pinyin,
        poiid: amap?.poiid || undefined
      };
      physBySi.set(si, phys);
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

  for (const cfg of HARBIN_LINES) {
    const slug = cfg.slug;
    const lineId = lineIdBySlug.get(slug)!;
    const amap = amapByName.get(cfg.amapName);
    const amapStations = orderedStationNames(amap ?? {});
    if (amapStations.length < 2) {
      throw new Error(`AMap station list empty for ${cfg.amapName}`);
    }

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    for (let i = 0; i < amapStations.length; i++) {
      const name = amapStations[i]!;
      const st = (amap?.st ?? []).find((x) => String(x.n ?? '').trim() === name);
      const phys = ensurePhys(String(st?.si ?? name), name);
      phys.lineNames.add(cfg.name);
      const id = stopIdOf(phys.id, slug);
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: cfg.loop ? false : i === 0 || i === amapStations.length - 1,
          source_id: name,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: { line_short_name: cfg.short, amap_order: i }
        });
      }
      physList.push(phys);
      stopIds.push(id);
    }

    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(slug)}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.loop
        ? `${cfg.name}环线`
        : `${amapStations[0]} → ${amapStations[amapStations.length - 1]}`,
      names: {
        zh: cfg.loop
          ? `${cfg.name}环线`
          : `${amapStations[0]}→${amapStations[amapStations.length - 1]}`,
        en: cfg.loop
          ? `${cfg.nameEn} loop`
          : `${amapStations[0]} to ${amapStations[amapStations.length - 1]}`
      },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: { line_short_name: cfg.short, ...(cfg.loop ? { loop: true } : {}) }
    });

    // Segments: consecutive stops, plus the closing edge on a ring.
    const edgeCount = cfg.loop ? stopIds.length : stopIds.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      pushSegment(
        lineId,
        stopById.get(stopIds[i]!)!,
        stopById.get(stopIds[(i + 1) % stopIds.length]!)!,
        AMAP_SOURCE
      );
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
        const id = `${NETWORK_ID}-${phys.id}-${slug}-${cfg.loop ? 'inner' : 'down'}`;
        if (!ttIds.has(id)) {
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            source_id: TT_SOURCE_BAIDU,
            // A closed ring has no terminus — the direction is the meaning.
            destination_stop_id: cfg.loop ? undefined : destDown,
            origin_stop_id: cfg.loop ? undefined : destUp,
            pattern_id: patternId,
            direction_type: cfg.loop ? 'loop_inner' : 'linear',
            direction_label: cfg.loop ? '内环' : 'down',
            first_train: downFirst,
            last_train: downLast,
            extras: { line_short_name: cfg.short, calendar: 'all_days' }
          });
        }
      }
      if (upFirst.length || upLast.length) {
        const id = `${NETWORK_ID}-${phys.id}-${slug}-${cfg.loop ? 'outer' : 'up'}`;
        if (!ttIds.has(id)) {
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            source_id: TT_SOURCE_BAIDU,
            destination_stop_id: cfg.loop ? undefined : destUp,
            origin_stop_id: cfg.loop ? undefined : destDown,
            pattern_id: patternId,
            direction_type: cfg.loop ? 'loop_outer' : 'linear',
            direction_label: cfg.loop ? '外环' : 'up',
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
  for (const phys of physBySi.values()) {
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
        amap_station_id: phys.si,
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived'
      }
    });
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '哈尔滨地铁',
    names: { zh: '哈尔滨地铁', en: 'Harbin Metro' },
    city: placeholderCity('CN-2301'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '线网拓扑/坐标/英文名/示意图来自 AMap Subway（2301_drw_haerbin.json，GCJ-02 原生）；' +
      '运营方官网 www.harbin-metro.com 目前全站停机维护（任意路径均返回同一 30 字节占位页），' +
      '且历史版本只发布散文与图片（票价及优惠政策/车站指南/运营时刻），无任何结构化接口，故未做 OCR；' +
      '首末班车与区间在车里程/时长实时查询百度路径规划 direction/v2/transit，' +
      '与运营方通过微信公众号「冰城出行」发布的 2025-05 首末车发车时刻表逐格比对一致（36/36）；' +
      'OD 票价按官网《地铁票价及优惠政策》的里程分段计价票制，在车轨道里程最短路计算（同站进出官方收最低票价 2 元，' +
      '本数据集沿用全网统一的对角线记 0 约定）；' +
      '换乘步行时间官方未公布，gapfill 图层以百度路径规划的换乘步行段实测补齐。'
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

/** Harbin runs one all-days schedule; the 7-element array repeats the value. */
function weekArray(value: string | null | undefined): string[] {
  const v = value ?? undefined;
  if (!v) return [];
  return [v, v, v, v, v, v, v];
}

/** Exposed for tests: line config lookup by AMap name. */
export function lineConfigFor(amapName: string): HarbinLineConfig | undefined {
  return HARBIN_LINES.find((c) => c.amapName === amapName);
}

/** Fold a station name the way the planner does (for lookups). */
export { foldStationName };
