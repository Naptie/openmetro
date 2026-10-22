/**
 * Canonical construction for Taiyuan Metro.
 *
 * Topology and first/last trains come from the operator's own API
 * (`www.tymetro.ltd/api/lines`): line order, stop order, per-direction
 * first/last trains (second precision in the source) and the station
 * records. Coordinates, English names, schematic pixels and line colours come
 * from the AMap subway dataset for adcode 1401 — the same dataset the
 * operator's own line map renders.
 */
import {
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
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
  TyOfficialLine,
  TyOfficialStation
} from './fetch.js';
import {
  TAIYUAN_FARE_POLICY,
  TAIYUAN_LINE_BY_API_ID,
  TAIYUAN_LINES,
  type TaiyuanLineConfig
} from './lines.js';

const NETWORK_ID = 'cn-taiyuan';

export const TY_API_SOURCE = 'tymetro-api';
export const AMAP_SOURCE = 'amap-subway-1401';

/** The operator marks a terminal with this literal instead of a clock time. */
const TERMINAL_MARKER = '终点站';

export interface TaiyuanCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** AMap POI id per station id — the planner's key. */
  plannerPoiids: Map<string, string>;
}

function lineIdOf(cfg: TaiyuanLineConfig): string {
  return `${NETWORK_ID}-line-${cfg.slug}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

/** `"lon,lat"` → coordinates. */
function parseOfficialPosition(
  raw: string | null | undefined
): { lon: number; lat: number } | undefined {
  if (!raw) return undefined;
  const [lonRaw, latRaw] = raw.split(',');
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

function parseSlCoord(raw: string | undefined): { lon: number; lat: number } | undefined {
  if (!raw) return undefined;
  const [lonRaw, latRaw] = raw.split(',');
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

function parsePixel(raw: string | undefined): { x: number; y: number } | undefined {
  if (!raw) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return undefined;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Truncate a source clock time to the canonical `HH:MM`.
 *
 * The operator publishes `HH:MM:SS`; the canonical timetable format is
 * `HH:MM`, and the exact seconds are kept in `extras` for provenance.
 *
 * Exported for tests.
 */
export function toHHMM(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t || t === TERMINAL_MARKER) return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 48 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln && !out.has(ln)) out.set(ln, line);
  }
  return out;
}

function amapStationsByName(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const out = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !out.has(n)) out.set(n, st);
    }
  }
  return out;
}

/**
 * Readable English label for a station.
 *
 * AMap publishes two romanisations: `multilang.n.en` (ALL CAPS, word
 * boundaries dropped — "TAIYUANZHAN XIGUANGCHANG") and `sp` (the pinyin
 * with word boundaries — "TaiYuan ZhanXi GuangChang"). The pinyin reads far
 * better, so it is preferred; the ALL CAPS form is kept as provenance.
 */
function englishNameOf(amap: AmapStation | undefined): string | undefined {
  const pinyin = String(amap?.sp ?? '').trim();
  const fromPinyin = pinyinToEnglish(pinyin);
  if (fromPinyin) return fromPinyin;
  const multilang = String(amap?.multilang?.n?.en ?? '').trim();
  if (multilang) return multilang;
  return undefined;
}

export function normalizeTaiyuan(input: {
  officialLines: TyOfficialLine[];
  amap: AmapSubwayDoc;
}): TaiyuanCanonical {
  const amapByName = amapLinesByName(input.amap);
  const amapStationByName = amapStationsByName(input.amap);

  const lineRecords: LineEncoded[] = [];
  const stopById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const physical = new Map<
    string,
    {
      id: string;
      zh: string;
      en?: string;
      pinyin?: string;
      location?: { lon: number; lat: number };
      locationSource?: string;
      schematic?: { x: number; y: number };
      poiid?: string;
      sid?: string;
      lineNames: Set<string>;
      officialStationIds: Set<number>;
      exits: string[];
      facilities: string[];
      photos: number;
      threeD?: string;
      siteDesc?: string;
      transfer: boolean;
    }
  >();

  const ensurePhysical = (
    official: TyOfficialStation
  ): typeof physical extends Map<string, infer V> ? V : never => {
    const zh = official.name.trim();
    let phys = physical.get(zh);
    if (phys) return phys;
    const amap = amapStationByName.get(zh);
    const en = englishNameOf(amap);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const officialLoc = parseOfficialPosition(official.position);
    const amapLoc = parseSlCoord(amap?.sl);
    const location = officialLoc ?? amapLoc;
    const id = `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`;
    phys = {
      id,
      zh,
      en,
      pinyin,
      location,
      locationSource: officialLoc ? 'official' : amapLoc ? 'amap' : undefined,
      schematic: parsePixel(amap?.p),
      poiid: amap?.poiid || undefined,
      sid: amap?.sid || undefined,
      lineNames: new Set(),
      officialStationIds: new Set([official.id]),
      exits: (official.exits ?? []).map((e) => e.name).filter(Boolean),
      facilities: (official.facilities ?? []).filter((f) => f.enabled !== false).map((f) => f.type),
      photos: (official.photos ?? []).length,
      threeD: official.threeDimg || official.threeDsrc || undefined,
      siteDesc: official.siteDesc || undefined,
      transfer: official.transfer === true
    };
    physical.set(zh, phys);
    return phys;
  };

  for (const official of input.officialLines) {
    const cfg = TAIYUAN_LINE_BY_API_ID.get(official.id);
    if (!cfg) {
      console.log(`  unknown official line id ${official.id} (${official.name}) — skipped`);
      continue;
    }
    const lineId = lineIdOf(cfg);
    const amapLine = amapByName.get(cfg.amapName);
    const color = amapLine?.cl ? `#${amapLine.cl.toLowerCase()}` : cfg.color;

    lineRecords.push({
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: cfg.nameEn },
      aliases: amapLine?.kn && amapLine.kn !== cfg.name ? [amapLine.kn] : [],
      color,
      text_color: undefined,
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: TY_API_SOURCE, id: String(official.id) },
        ...(amapLine?.li
          ? String(amapLine.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: 'source',
        length_km: cfg.lengthKm,
        station_count: cfg.stationCount,
        opened: cfg.opened,
        color_source: AMAP_SOURCE,
        amap_color: amapLine?.cl,
        amap_name: amapLine?.ln,
        official_id: official.id,
        official_description: String(official.description ?? '')
          .replace(/<[^>]+>/g, '')
          .trim(),
        line_map_image: official.mapImg || undefined
      }
    });

    const ordered = [...official.stops].sort((a, b) => a.seq - b.seq);
    const stopIds: string[] = [];

    for (const stop of ordered) {
      const phys = ensurePhysical(stop.station);
      phys.lineNames.add(cfg.name);
      phys.officialStationIds.add(stop.station.id);
      if (stop.station.transfer) phys.transfer = true;
      const stopId = stopIdOf(phys.id, cfg.short);
      stopIds.push(stopId);
      if (!stopById.has(stopId)) {
        stopById.set(stopId, {
          id: stopId,
          station_id: phys.id,
          line_id: lineId,
          sequence: stop.seq,
          is_terminal: stop.seq === 1 || stop.seq === ordered.length,
          location: undefined,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          source_id: phys.sid,
          extras: {
            line_short_name: cfg.short,
            official_stop_id: stop.id,
            official_station_id: stop.station.id,
            amap_poiid: phys.poiid
          }
        });
      }
    }

    const origin = stopIds[0]!;
    const terminal = stopIds[stopIds.length - 1]!;
    patterns.push({
      id: `${NETWORK_ID}-pattern-${cfg.slug}-primary`,
      line_id: lineId,
      name: `${cfg.name}全线`,
      names: { zh: `${cfg.name}全线`, en: `${cfg.nameEn} full line` },
      stop_ids: stopIds,
      origin_stop_id: origin,
      terminal_stop_id: terminal,
      is_primary: true,
      junction_stop_id: undefined,
      color,
      source_ids: [{ source: TY_API_SOURCE, id: String(official.id) }],
      extras: { line_short_name: cfg.short }
    });

    for (let i = 0; i < stopIds.length - 1; i++) {
      const a = stopById.get(stopIds[i]!)!;
      const b = stopById.get(stopIds[i + 1]!)!;
      segments.push({
        id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        travel_time_seconds: undefined,
        travel_time_source: undefined,
        travel_time_derived_from: undefined,
        distance_km: undefined,
        geometry: undefined,
        source_id: TY_API_SOURCE,
        extras: { line_short_name: cfg.short }
      });
    }

    // First/last trains: "up" runs toward the last stop of the published
    // order, "down" toward the first one. A terminal has no service in the
    // direction that points away from the line.
    for (const stop of ordered) {
      const phys = physical.get(stop.station.name.trim())!;
      const stopId = stopIdOf(phys.id, cfg.short);
      const patternId = `${NETWORK_ID}-pattern-${cfg.slug}-primary`;
      for (const dir of [
        {
          key: 'up' as const,
          first: stop.upFirstTime,
          last: stop.upLastTime,
          destination: terminal,
          origin: origin,
          label: 'up'
        },
        {
          key: 'down' as const,
          first: stop.downFirstTime,
          last: stop.downLastTime,
          destination: origin,
          origin: terminal,
          label: 'down'
        }
      ]) {
        const first = toHHMM(dir.first);
        const last = toHHMM(dir.last);
        if (!first && !last) continue;
        timetables.push({
          id: `${NETWORK_ID}-tt-${stopId}-${dir.key}`,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          source_id: TY_API_SOURCE,
          destination_stop_id: dir.destination,
          origin_stop_id: dir.origin,
          pattern_id: patternId,
          direction_type: 'linear',
          direction_label: dir.label,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          is_arrival: dir.first === TERMINAL_MARKER ? true : undefined,
          service: undefined,
          extras: {
            line_short_name: cfg.short,
            calendar: 'all_days',
            // The source publishes HH:MM:SS; the canonical form is HH:MM.
            exact_first: dir.first ?? undefined,
            exact_last: dir.last ?? undefined
          }
        });
      }
    }
  }

  const stops = [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const plannerPoiids = new Map<string, string>();

  const stations: StationEncoded[] = [];
  for (const phys of physical.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (location) officialLocations.set(phys.id, location);
    if (phys.poiid) plannerPoiids.set(phys.id, phys.poiid);
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
        { source: TY_API_SOURCE, id: [...phys.officialStationIds].join(',') },
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        amap_en: String(amapStationByName.get(phys.zh)?.multilang?.n?.en ?? '') || undefined,
        /** AMap POI id — the route planner's station key. */
        amap_poiid: phys.poiid,
        lines: [...phys.lineNames],
        // `location_source` is re-tagged by fillCoordinates when the
        // enrichment layer runs; `official_position` records that the
        // operator's own API published a coordinate for this station.
        location_source: phys.locationSource,
        official_position: phys.locationSource === 'official' ? true : undefined,
        names_source: phys.en ? 'source' : 'derived',
        transfer_station: phys.transfer ? true : undefined,
        exits: phys.exits.length ? phys.exits : undefined,
        facilities: phys.facilities.length ? phys.facilities : undefined,
        photo_count: phys.photos || undefined,
        model_3d: phys.threeD,
        site_desc: phys.siteDesc
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '太原地铁',
    names: { zh: '太原地铁', en: 'Taiyuan Metro' },
    city: placeholderCity('CN-1401'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与首末班来自太原地铁官网 API（www.tymetro.ltd/api/lines，秒级精度、双向逐站发布）；坐标/英文名/线色/示意图来自 AMap 地铁数据集 1401（官网线网图同源）；分段时间、里程与区间几何来自官网「路线查询」所调用的同一规划器接口；OD 票价取自同一规划器，与官方里程分段计价票制逐对一致；大南门站内换乘步行时间由核心 gapfill 层（百度规划器）实测，官网规划器仅发布换乘路径长度。'
  };

  return {
    network,
    lines: lineRecords.sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: timetables.sort((a, b) => a.id.localeCompare(b.id)),
    officialLocations,
    plannerPoiids
  };
}

/** Fare policy text kept next to the network for provenance. */
export const TY_FARE_POLICY_NOTE = TAIYUAN_FARE_POLICY;
export const TY_LINE_CONFIGS = TAIYUAN_LINES;
