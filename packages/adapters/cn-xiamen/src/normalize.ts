import {
  asciiSlug,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
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
  type TimetableEncoded,
  titleCaseRoman
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, XiamenSources } from './fetch.js';
import { XIAMEN_LINES } from './lines.js';
import type { DirectedTimes } from './timetables.js';

const NETWORK_ID = 'cn-xiamen';

const AMAP_SOURCE = 'amap-subway-3502';
const CMS_SOURCE = 'xmgdjt-cms';

export interface XiamenCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

export function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) out.set(ln, line);
  }
  return out;
}

/** AMap publishes station romanisations in CamelCase; prose case reads better. */
function normalizePinyin(s: string | undefined): string | undefined {
  const t = (s ?? '').trim();
  return t ? titleCaseRoman(t) : undefined;
}

export function normalizeXiamen(
  input: XiamenSources,
  mergedTimesByLine: Map<string, DirectedTimes[]>
): XiamenCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();

  for (const cfg of XIAMEN_LINES) {
    const lineId = lineIdOf(cfg.short);
    lineIdByShort.set(cfg.short, lineId);
    const amap = amapByName.get(cfg.amapName);
    const cms = input.cmsLines.get(cfg.cmsLineId);
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecordByShort.set(cfg.short, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: amap?.kn && amap.kn !== cfg.name ? [String(amap.kn)] : [],
      // The operator's own brand colour wins over the AMap rendering.
      color: hexToCss(cms?.lineColor ?? undefined) ?? hexToCss(amap?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: false,
      source_ids: [
        { source: AMAP_SOURCE, id: cfg.amapName },
        { source: CMS_SOURCE, id: cfg.cmsLineId },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: 'derived',
        amap_color: amap?.cl,
        cms_color: cms?.lineColor,
        cms_code: cms?.lineCode,
        cms_service_span:
          cms?.firstTime && cms?.lastTime ? `${cms.firstTime}-${cms.lastTime}` : undefined,
        baidu_vehicle_name: cfg.baiduName,
        timetable_source: cfg.cmsTimetable ? 'xmgdjt-cms' : 'baidu-directionlite-transit'
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
      // Display English stays empty here: Wikidata fills proper names and the
      // core falls back to the AMap pinyin recorded in extras.
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(undefined, zh, pinyin)}`,
        zh,
        en: '',
        lineNames: new Set(),
        location: parseSlCoord(amap?.sl),
        schematic: parsePixel(amap?.p),
        pinyin: normalizePinyin(amap?.sp),
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

  for (const cfg of XIAMEN_LINES) {
    const short = cfg.short;
    const lineId = lineIdByShort.get(short)!;
    const amap = amapByName.get(cfg.amapName);
    const amapStations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (amapStations.length < 2) {
      throw new Error(`AMap station list empty for ${cfg.amapName}`);
    }

    // Operator station ids keyed by folded name; the CMS shares one id per
    // physical station across lines, which is what the fare planner needs.
    const foldToCmsId = new Map<string, string>();
    const foldToCmsName = new Map<string, string>();
    for (const s of input.cmsLineStations.get(cfg.cmsLineId) ?? []) {
      const key = foldStationName(s.stationName);
      if (!foldToCmsId.has(key)) {
        foldToCmsId.set(key, s.stationId);
        foldToCmsName.set(key, s.stationName);
      }
    }
    const unmatched: string[] = [];
    for (const n of amapStations) {
      if (!foldToCmsId.has(foldStationName(n))) unmatched.push(n);
    }
    if (unmatched.length > 0) {
      throw new Error(
        `${cfg.name}: AMap stations absent from the CMS line-station list: ${unmatched.join(', ')}`
      );
    }

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    for (let i = 0; i < amapStations.length; i++) {
      const zh = amapStations[i]!;
      const phys = ensurePhys(zh);
      phys.lineNames.add(cfg.name);
      const id = `${phys.id}-${short}`;
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === amapStations.length - 1,
          source_id: foldToCmsId.get(foldStationName(zh)),
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            amap_order: i,
            station_code: foldToCmsId.get(foldStationName(zh))
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
        { source: CMS_SOURCE, id: cfg.cmsLineId }
      ],
      extras: { line_short_name: short }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!, AMAP_SOURCE);
    }

    // First/last trains: CMS rows (lines 1–3) with planner fill for gaps,
    // wholesale planner harvest for lines 4/6. Destination name resolves the
    // headsign stop; direction labels follow the operator's wording.
    const stopIdByFold = new Map<string, string>();
    for (let i = 0; i < amapStations.length; i++) {
      stopIdByFold.set(foldStationName(amapStations[i]!), stopIds[i]!);
    }
    const merged = mergedTimesByLine.get(short) ?? [];
    for (const t of merged) {
      const phys = physByFold.get(foldStationName(t.stationName));
      if (!phys) continue;
      const stopId = stopIdByFold.get(foldStationName(t.stationName));
      const destStopId = stopIdByFold.get(foldStationName(t.destName));
      if (!stopId || !destStopId) continue;
      const first = t.first ? [t.first] : [];
      const last = t.last ? [t.last] : [];
      if (!first.length && !last.length) continue;
      const id = `${NETWORK_ID}-${phys.id}-${short}-${t.direction}`;
      if (ttIds.has(id)) continue;
      ttIds.add(id);
      timetables.push({
        id,
        station_id: phys.id,
        stop_id: stopId,
        line_id: lineId,
        source_id: t.source,
        destination_stop_id: destStopId,
        pattern_id: patternId,
        direction_type: 'linear',
        direction_label: `往${t.destName}方向`,
        first_train: first,
        last_train: last,
        service: 'all_days',
        extras: { line_short_name: short, calendar: 'all_days' }
      });
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
      // Empty en is deliberate: Wikidata fills proper names and the core
      // falls back to the AMap pinyin in extras — never seed pinyin here.
      names: { zh: phys.zh, en: '' },
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
        location_provider: location ? 'amap_subway' : undefined
      }
    });
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '厦门地铁',
    names: { zh: '厦门地铁', en: 'Xiamen Metro' },
    city: placeholderCity('CN-3502'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/坐标/示意图来自 AMap Subway，并与官网 CMS（xmgdjt.com.cn/api/transit）逐线站表交叉校验；线路颜色/服务时段/官方站点编号来自官网 CMS；1–3 号线首末班来自官网 CMS（含目的站），4/6 号线 CMS 无时刻记录、由百度路径规划（directionlite transit）收割，2 号线个别缺记录站点同样以百度补齐；票价来自官网票价查询接口（仅数字编号站点，4/6 号线未发布为 null）。官网同页还提供 3 条 BRT 线路（type=2），非轨道交通制式，未收录。'
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
