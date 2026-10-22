import {
  asciiSlug,
  deriveLineEnglishName,
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
  type TimetableEncoded,
  titleCaseRoman
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, HohhotSources } from './fetch.js';
import {
  HOHHOT_FARE_POLICY,
  HOHHOT_INTERCHANGE,
  HOHHOT_LINES,
  HOHHOT_SCHEDULE_NOTE,
  RENAMED_STATIONS_2023,
  STATION_EN_OVERRIDES,
  STATION_NAME_OVERRIDES
} from './lines.js';
import type { HarvestedStationTimes } from './timetables.js';

const NETWORK_ID = 'cn-hohhot';

const AMAP_SOURCE = 'amap-subway-1501';
const TT_SOURCE_BAIDU = 'baidu-direction-v2-transit';

export interface HohhotCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

/** Resolve an English name for a station, preferring the AMap translations. */
function resolveEnglishName(st: AmapStation, canonical: string): string | undefined {
  const override = STATION_EN_OVERRIDES[canonical];
  if (override) return override;
  const multilang = String(st.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(multilang);
  const en = String(st.en ?? '').trim();
  if (isUsableEnglish(en)) return titleCaseRoman(en);
  const fromPinyin = pinyinToEnglish(String(st.sp ?? ''));
  if (fromPinyin) return fromPinyin;
  // Wikidata's fillStationEnglishNames in run.ts supplies the rest — never
  // invent names.
  return undefined;
}

function lineIdOf(slug: string): string {
  return `${NETWORK_ID}-line-${readableSlug(slug) || asciiSlug(slug)}`;
}

function stopIdOf(stationId: string, slug: string): string {
  return `${stationId}-${slug}`;
}

/** AMap line name → line. */
function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) out.set(ln, line);
  }
  return out;
}

/** The operator's current official name for an AMap station name. */
export function officialStationName(amapName: string): string {
  return STATION_NAME_OVERRIDES[amapName] ?? amapName;
}

export function normalizeHohhot(
  input: HohhotSources,
  harvestedRows: Map<string, HarvestedStationTimes[]>
): HohhotCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordBySlug = new Map<string, LineEncoded>();
  const lineIdBySlug = new Map<string, string>();

  for (const cfg of HOHHOT_LINES) {
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
        length_km: cfg.lengthKm,
        station_count: cfg.stationCount,
        opened: cfg.opened,
        fare_policy: 'mileage'
      }
    });
  }

  type Phys = {
    id: string;
    /** The operator's current official name. */
    zh: string;
    /** Name as published in the AMap dataset (the lookup key). */
    amapName: string;
    en: string;
    lineNames: Set<string>;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
  };

  const physByName = new Map<string, Phys>();
  const amapStationByName = new Map<string, AmapStation>();
  for (const line of input.amapSubway.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !amapStationByName.has(n)) amapStationByName.set(n, st);
    }
  }

  const ensurePhys = (amapName: string): Phys => {
    const canonical = officialStationName(amapName);
    let phys = physByName.get(canonical);
    if (phys) return phys;
    const amap = amapStationByName.get(amapName);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const en = resolveEnglishName(amap ?? {}, canonical) ?? '';
    phys = {
      id: `${NETWORK_ID}-${stationIdFor(en, canonical, pinyin)}`,
      zh: canonical,
      amapName,
      en,
      lineNames: new Set(),
      location: parseSlCoord(amap?.sl),
      schematic: parsePixel(amap?.p),
      pinyin,
      poiid: amap?.poiid || undefined
    };
    physByName.set(canonical, phys);
    return phys;
  };

  const stopById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

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

  for (const cfg of HOHHOT_LINES) {
    const slug = cfg.slug;
    const lineId = lineIdBySlug.get(slug)!;
    const amap = amapByName.get(cfg.amapName);
    const amapStations = (amap?.st ?? [])
      .map((s) => String(s.n ?? '').trim())
      .filter((n) => n.length > 0);
    if (amapStations.length < 2) {
      throw new Error(`AMap station list empty for ${cfg.amapName}`);
    }
    if (amapStations.length !== cfg.stationCount) {
      throw new Error(
        `${cfg.name}: AMap lists ${amapStations.length} stations, the operator publishes ${cfg.stationCount}`
      );
    }

    const canonicalNames = amapStations.map(officialStationName);
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

    const originStop = stopIds[0]!;
    const terminalStop = stopIds[stopIds.length - 1]!;
    const originName = canonicalNames[0]!;
    const terminalName = canonicalNames[canonicalNames.length - 1]!;
    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(slug)}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${originName} → ${terminalName}`,
      names: {
        zh: `${originName}→${terminalName}`,
        en: `${originName} to ${terminalName}`
      },
      stop_ids: stopIds,
      origin_stop_id: originStop,
      terminal_stop_id: terminalStop,
      is_primary: true,
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: { line_short_name: cfg.short }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!, AMAP_SOURCE);
    }

    // First/last trains, harvested from the Baidu planner. `down` heads toward
    // the last station of the AMap order, `up` toward the first one; the
    // planner reports the first/last *departure* at the boarding station, so
    // the line's terminus has no entry in the direction pointing away from
    // the line.
    const rows = harvestedRows.get(slug);
    if (!rows?.length) continue;
    const rowByName = new Map(rows.map((r) => [r.stationName, r]));

    for (let i = 0; i < canonicalNames.length; i++) {
      const name = canonicalNames[i]!;
      const row = rowByName.get(name);
      if (!row) continue;
      const phys = physList[i]!;
      const stopId = stopIds[i]!;

      const dirs: {
        key: 'down' | 'up';
        first: string | null | undefined;
        last: string | null | undefined;
        destination: string;
        origin: string;
        destinationStop: string;
        originStop: string;
      }[] = [
        {
          key: 'down',
          first: row.downFirst,
          last: row.downLast,
          destination: terminalName,
          origin: originName,
          destinationStop: terminalStop,
          originStop: originStop
        },
        {
          key: 'up',
          first: row.upFirst,
          last: row.upLast,
          destination: originName,
          origin: terminalName,
          destinationStop: originStop,
          originStop: terminalStop
        }
      ];

      for (const dir of dirs) {
        if (!dir.first && !dir.last) continue;
        const id = `${NETWORK_ID}-tt-${stopId}-${dir.key}`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        timetables.push({
          id,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          source_id: TT_SOURCE_BAIDU,
          destination_stop_id: dir.destinationStop,
          origin_stop_id: dir.originStop,
          pattern_id: patternId,
          direction_type: 'linear',
          direction_label: `往${dir.destination}方向`,
          first_train: dir.first ? [dir.first] : [],
          last_train: dir.last ? [dir.last] : [],
          service: 'all_days',
          extras: { line_short_name: cfg.short, calendar: 'all_days' }
        });
      }
    }
  }

  const stops: StopEncoded[] = [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id));

  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  for (const phys of physByName.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (location) officialLocations.set(phys.id, location);
    const renamedFrom = RENAMED_STATIONS_2023.find((r) => r.to === phys.zh)?.from;
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
        { source: AMAP_SOURCE, id: phys.amapName },
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : [])
      ],
      extras: {
        pinyin: phys.pinyin,
        lines: [...phys.lineNames],
        amap_name: phys.amapName !== phys.zh ? phys.amapName : undefined,
        renamed_from: renamedFrom,
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived'
      }
    });
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));

  /**
   * Network-level documentation of the data provenance and its limits.
   * Kept out of the object literal so every claim stays individually
   * reviewable when a source changes.
   */
  const NETWORK_NOTES = [
    '线网：2条线、43座车站、约49.03公里，唯一换乘站为新华广场（十字换乘，无需出闸）。3/4/5/6号线仍处规划审批阶段，尚未开工。',
    '拓扑/坐标/英文名/线色取自 AMap Subway（1501_drw_huhehaote.json）——官网的线网图、首末班车时刻表与票价表均以图片发布，无结构化接口，未做 OCR。',
    '首末班车实时查询百度路径规划 direction/v2/transit（detail.first_time/last_time 为本站首/末班车的发车时刻，非到达时刻），',
    '并与官网《首末站首末班车时间一览表》逐条核对一致（伊利健康谷 22:09、坝堰(机场) 22:01、阿尔山路 22:04、塔利东路 22:00）。',
    '区间运行时间由官网公布的末班车发车时刻逐站相减推得（travel_time_source=last_train）；区间里程取百度路径规划的地铁区间实测量。',
    '站点更名（2023-11-01）：呼钢东路→呼钢南路、新城图书馆→北山公园、东二环路→丝绸之路大道；另 坝堰(机场)→坝堰(机场)(国内航站楼)、白塔西→白塔西(国际航站楼)。本站名采用运营方现名。',
    `票制票价：${HOHHOT_FARE_POLICY}`,
    'OD 票价优先取百度路径规划报价——仅采纳在起点站上车、终点站下车且全程无公交的地铁行程；规划器对部分跨线 OD 以公交替代站内换乘、给不出地铁行程，这些 OD 改用上述里程分段计价票制乘以线路实测里程推算，并与规划器报价逐对比对。',
    HOHHOT_SCHEDULE_NOTE,
    `唯一换乘站：${HOHHOT_INTERCHANGE}。`
  ].join('');
  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '呼和浩特地铁',
    names: { zh: '呼和浩特地铁', en: 'Hohhot Metro' },
    city: placeholderCity('CN-1501'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes: NETWORK_NOTES
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
