import {
  isUsableEnglish,
  titleCaseRoman,
  asciiSlug,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  parsePixel,
  parseSlCoord,
  pinyinToEnglish,
  readableSlug,
  stationIdFor,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import type {
  AmapLine,
  AmapStation,
  AmapSubwayDoc,
  NanjingSources,
  NjOfficialStation
} from './fetch.js';
import { fixRowDirection, type ParsedTimetableImage, weekArray } from './times.js';

const NETWORK_ID = 'cn-nanjing';

/**
 * GCJ-02 pins for stations AMap subway omits (renames / new stops). Baidu
 * Place API is the source of these coordinates; they are data, not a cache.
 */
export const KNOWN_LOCATIONS: Record<string, { lon: number; lat: number }> = {
  河海大学佛城西路: { lon: 118.79134, lat: 31.914276 },
  南医大江苏经贸学院: { lon: 118.890086, lat: 31.933693 },
  临江: { lon: 118.665509, lat: 32.057099 },
  南京林业大学新庄: { lon: 118.810315, lat: 32.07658 },
  徐庄: { lon: 118.889128, lat: 32.084649 },
  湖南路安工大: { lon: 118.530049, lat: 31.687821 },
  湖北路二中: { lon: 118.530064, lat: 31.70589 }
};

const NJ_SOURCE = 'njmetro-stationList';
const AMAP_SOURCE = 'amap-subway-3201';
const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface NanjingCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: never[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}



function resolveEnglishName(
  amapEn: string | undefined,
  pinyin: string | undefined,
  zh: string
): string | undefined {
  const en = (amapEn ?? '').trim();
  if (isUsableEnglish(en)) return en;
  const fromPinyin = pinyinToEnglish(pinyin);
  if (fromPinyin) return fromPinyin;
  // Wikidata fillMissingEnglish in run.ts supplies the rest — never invent names.
  return undefined;
}






function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

/** S1 airport express; other S-codes are suburban/intercity. */
function modeForShort(short: string): LineEncoded['mode'] {
  if (short === 'S1') return 'airport_express';
  if (/^S\d+$/.test(short)) return 'suburban_rail';
  return 'metro';
}

function amapLinesByShort(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    // "1号线" / "S1号线(机场线)" / "S2号线(宁马线)"
    const m = /^S?(\d+)号线/.exec(ln);
    if (!m) continue;
    const short = ln.startsWith('S') ? `S${m[1]}` : m[1]!;
    out.set(short, line);
  }
  return out;
}

function amapStationsByFold(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const out = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      out.set(foldStationName(n), st);
    }
  }
  return out;
}

export function normalizeNanjing(
  input: NanjingSources,
  timetableImages: ParsedTimetableImage[] = []
): NanjingCanonical {
  const amapByName = amapLinesByShort(input.amapSubway);
  const amapStationByName = amapStationsByFold(input.amapSubway);

  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();

  for (const line of input.lines) {
    const short = line.shortName;
    const lineId = lineIdOf(short);
    lineIdByShort.set(short, lineId);
    const amap = amapByName.get(short);
    const lineName = line.lineName;
    const enFromAmap = String(amap?.el ?? amap?.multilang?.ln?.en ?? '').trim();
    const nameEn = enFromAmap || deriveLineEnglishName(lineName) || `Line ${short}`;
    lineRecordByShort.set(short, {
      id: lineId,
      name: lineName,
      names: { zh: lineName, en: nameEn },
      aliases: amap?.kn && amap.kn !== lineName ? [String(amap.kn)] : [],
      color: hexToCss(amap?.cl),
      short_name: short,
      mode: modeForShort(short),
      status: 'operating',
      loop: false,
      source_ids: [
        { source: NJ_SOURCE, id: line.reLineId },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: enFromAmap ? 'source' : 'derived',
        amap_color: amap?.cl,
        amap_name: amap?.ln,
        official_re_line_id: line.reLineId
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


/** AMap often publishes composite names (中山陵音乐台·孝陵卫); official is a part. */
function findAmapByContainment(
  byFold: Map<string, AmapStation>,
  key: string
): AmapStation | undefined {
  if (!key) return undefined;
  for (const [k, st] of byFold) {
    if (k.includes(key) || key.includes(k)) return st;
  }
  return undefined;
}

  const ensurePhys = (zhRaw: string): Phys => {
    const zh = zhRaw.trim();
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    if (!phys) {
      const amap = amapStationByName.get(key) ?? findAmapByContainment(amapStationByName, key);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(String(amap?.en ?? ''), pinyin, zh) ?? '';
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh)}`,
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

  const stopById = new Map<string, StopEncoded & { line_short: string }>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const timetableByStem = new Map(timetableImages.map((t) => [t.stem, t]));

  for (const line of input.lines) {
    const short = line.shortName;
    const lineId = lineIdByShort.get(short)!;
    const official: NjOfficialStation[] = [...(input.stationsByLine[line.reLineId] ?? [])].sort(
      (a, b) => a.stationOrder - b.stationOrder
    );
    if (official.length < 2) continue;

    const physList: Phys[] = [];
    const stopIds: string[] = [];
    for (let i = 0; i < official.length; i++) {
      const raw = official[i]!;
      const phys = ensurePhys(raw.stationName);
      phys.lineNames.add(line.lineName);
      const id = stopIdOf(phys.id, short);
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === official.length - 1,
          source_id: raw.rowId,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            official_order: raw.stationOrder,
            official_row_id: raw.rowId
          },
          line_short: short
        });
      }
      physList.push(phys);
      stopIds.push(id);
    }

    // Official stationOrder is one terminus → the other (downstream).
    const patternId = `${NETWORK_ID}-pattern-${asciiSlug(short)}-primary`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${official[0]!.stationName} → ${official[official.length - 1]!.stationName}`,
      names: {
        zh: `${official[0]!.stationName}→${official[official.length - 1]!.stationName}`,
        en: `${official[0]!.stationName} to ${official[official.length - 1]!.stationName}`
      },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: NJ_SOURCE, id: line.reLineId }],
      extras: {
        direction: 'official_station_order',
        line_short_name: short
      }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      const a = stopIds[i]!;
      const b = stopIds[i + 1]!;
      const key = [a, b].sort().join('|');
      if (segmentKeys.has(key)) continue;
      segmentKeys.add(key);
      const physA = physList[i]!;
      const physB = physList[i + 1]!;
      segments.push({
        id: `${NETWORK_ID}-seg-${a}-${b}`,
        line_id: lineId,
        from_stop_id: a,
        to_stop_id: b,
        from_station_id: physA.id,
        to_station_id: physB.id,
        direction: 'both',
        source_id: `${NJ_SOURCE}:${line.reLineId}`
      });
    }

    // First/last trains from Baidu Direction Lite (official station order).
    const parsedRaw = timetableByStem.get(short);
    if (parsedRaw && parsedRaw.rows.length) {
      const { rows: parsedRows, swapped } = fixRowDirection(parsedRaw.rows);
      if (swapped) {
        console.log(`    ${short}: swapped mirrored up/down timetable columns`);
      }
      const ttSource = TT_SOURCE_BAIDU;
      const destDown = stopIds[stopIds.length - 1]!;
      const destUp = stopIds[0]!;
      for (let i = 0; i < official.length; i++) {
        const row = parsedRows[i];
        if (!row) continue;
        const phys = physList[i]!;
        const stopId = stopIds[i]!;
        const downFirst = weekArray(row.downFirst, row.downFirst);
        const downLast = weekArray(row.downLastStd, row.downLastFri ?? row.downLastStd);
        const upFirst = weekArray(row.upFirst, row.upFirst);
        const upLast = weekArray(row.upLastStd, row.upLastFri ?? row.upLastStd);

        if (downFirst.length || downLast.length) {
          const id = `${NETWORK_ID}-${phys.id}-${short}-down`;
          if (!ttIds.has(id)) {
            ttIds.add(id);
            timetables.push({
              id,
              station_id: phys.id,
              stop_id: stopId,
              line_id: lineId,
              source_id: ttSource,
              destination_stop_id: destDown,
              origin_stop_id: stopIds[0]!,
              pattern_id: patternId,
              direction_type: 'linear',
              direction_label: 'down',
              first_train: downFirst,
              last_train: downLast,
              extras: {
                line_short_name: short,
                calendar: 'sun-thu / fri-sat',
                image_stem: short
              }
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
              source_id: ttSource,
              destination_stop_id: destUp,
              origin_stop_id: stopIds[stopIds.length - 1]!,
              pattern_id: patternId,
              direction_type: 'linear',
              direction_label: 'up',
              first_train: upFirst,
              last_train: upLast,
              extras: {
                line_short_name: short,
                calendar: 'sun-thu / fri-sat',
                image_stem: short
              }
            });
          }
        }
      }
    }
  }

  const stops: StopEncoded[] = [...stopById.values()]
    .map(({ line_short: _lineShort, ...stop }) => stop)
    .sort((a, b) => a.id.localeCompare(b.id));

  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  for (const phys of physByFold.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const known = KNOWN_LOCATIONS[phys.zh] ?? KNOWN_LOCATIONS[foldStationName(phys.zh)];
    const loc = phys.location ?? known;
    const location =
      loc != null ? { lon: loc.lon, lat: loc.lat, crs: 'gcj02' as const } : undefined;
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
        { source: NJ_SOURCE, id: phys.zh },
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
  // First/last harvest can miss a station side (terminus dead-end, planner gap).
  // Never demote operating stations to out_of_service on missing timetable rows.
  const withTimes = stations;

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '南京地铁',
    names: { zh: '南京地铁', en: 'Nanjing Metro' },
    city: {
      id: 'CN-3201',
      name: { zh: '南京', en: 'Nanjing' },
      country: 'CN',
      population: 9547000,
      area: 6587,
      location: { type: 'Point', coordinates: [118.7969, 32.0603] }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑来自南京地铁官网 get-stationList；线色/坐标/英文名来自 AMap Subway 与百度 Place；首末班来自百度路径规划（directionlite transit），每次同步实时查询；票价来自 mobileTicketAction/getPrice.do。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: withTimes.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    transfers: [],
    timetables: filteredTimetables,
    officialLocations
  };
}
