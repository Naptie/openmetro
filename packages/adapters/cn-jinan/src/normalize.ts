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
import type { AmapLine, AmapStation, AmapSubwayDoc, JinanSources } from './fetch.js';
import { JINAN_LINES, LINE_SERVICE_NOTES, STATION_EN_OVERRIDES } from './lines.js';
import {
  fixLinearRowDirection,
  type HarvestedStationTimes,
  isLoopTimes,
  type LinearStationTimes,
  weekArrayJinan
} from './timetables.js';

const NETWORK_ID = 'cn-jinan';

const AMAP_SOURCE = 'amap-subway-3701';
const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface JinanCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

function resolveEnglishName(st: AmapStation, zh: string): string | undefined {
  const override = STATION_EN_OVERRIDES[zh] ?? STATION_EN_OVERRIDES[foldStationName(zh)];
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

/**
 * AMap swaps the two Line 6 terminus coordinates: as published, the polyline
 * cusps 180° at 梁王西, which no metro line does and data:verify rejects.
 * The official map draws 济南东站 → 梁王西 → 梁王 west-to-east, so the
 * terminus 梁王 takes the eastern coordinate pair.
 */
export const STATION_COORD_OVERRIDES: Record<string, { lon: number; lat: number }> = {
  梁王: { lon: 117.188781, lat: 36.747173 },
  梁王西: { lon: 117.176455, lat: 36.747458 }
};

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

export function normalizeJinan(
  input: JinanSources,
  harvestedRows: Map<string, HarvestedStationTimes[]>
): JinanCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();

  for (const cfg of JINAN_LINES) {
    const lineId = lineIdOf(cfg.short);
    lineIdByShort.set(cfg.short, lineId);
    const amap = amapByName.get(cfg.amapName);
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecordByShort.set(cfg.short, {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: amap?.kn && amap.kn !== cfg.name ? [String(amap.kn)] : [],
      color: hexToCss(amap?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: cfg.loop,
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
        // Official English from the network-map legend, not a derivation.
        names_source: 'source',
        amap_color: amap?.cl,
        amap_name: amap?.ln,
        baidu_vehicle_name: cfg.baiduName,
        fare_policy: cfg.fare,
        ...(cfg.throughRunWith ? { through_run_with: cfg.throughRunWith } : {}),
        ...(LINE_SERVICE_NOTES[cfg.short] ? { service_note: LINE_SERVICE_NOTES[cfg.short] } : {})
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
      const en = resolveEnglishName(amap ?? {}, zh) ?? '';
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
        zh,
        en,
        lineNames: new Set(),
        location:
          STATION_COORD_OVERRIDES[zh] ?? STATION_COORD_OVERRIDES[key] ?? parseSlCoord(amap?.sl),
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

  for (const cfg of JINAN_LINES) {
    const short = cfg.short;
    const lineId = lineIdByShort.get(short)!;
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
      const id = stopIdOf(phys.id, short);
      if (!stopById.has(id)) {
        stopById.set(id, {
          id,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          // A loop line has no termini; both ring ends are interior stations.
          is_terminal: !cfg.loop && (i === 0 || i === amapStations.length - 1),
          source_id: amapStations[i]!,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            amap_order: i
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
      source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
      extras: {
        line_short_name: short,
        ...(cfg.loop ? { pattern_role: 'loop' } : {}),
        ...(cfg.throughRunWith ? { through_run_with: cfg.throughRunWith } : {})
      }
    });

    for (let i = 0; i + 1 < stopIds.length; i++) {
      pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!, AMAP_SOURCE);
    }

    // Close the ring: the two published ends are physically adjacent.
    if (cfg.loop) {
      const a = stopById.get(stopIds[0]!)!;
      const b = stopById.get(stopIds[stopIds.length - 1]!)!;
      const key = [a.id, b.id].sort().join('|');
      if (!segments.some((s) => [s.from_stop_id, s.to_stop_id].sort().join('|') === key)) {
        segments.push({
          id: `${NETWORK_ID}-seg-${a.id}-${b.id}`,
          line_id: lineId,
          from_stop_id: a.id,
          to_stop_id: b.id,
          from_station_id: a.station_id,
          to_station_id: b.station_id,
          direction: 'both',
          source_id: `${AMAP_SOURCE}:loop-closure`,
          extras: { role: 'loop_closure' }
        });
      }
    }

    // First/last trains from Baidu Direction Lite (AMap station order).
    const rows = harvestedRows.get(short);
    if (!rows?.length) continue;
    const destDown = stopIds[stopIds.length - 1]!;
    const destUp = stopIds[0]!;

    if (cfg.loop) {
      for (let i = 0; i < amapStations.length; i++) {
        const row = rows[i];
        if (!row || !isLoopTimes(row)) continue;
        const phys = physList[i]!;
        const stopId = stopIds[i]!;
        for (const ring of [
          { key: 'outer' as const, type: 'loop_outer' as const, label: '外环' },
          { key: 'inner' as const, type: 'loop_inner' as const, label: '内环' }
        ]) {
          const first = row[`${ring.key}First` as const];
          const last = row[`${ring.key}Last` as const];
          if (!first && !last) continue;
          const id = `${NETWORK_ID}-${phys.id}-${short}-${ring.key}`;
          if (ttIds.has(id)) continue;
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            source_id: TT_SOURCE_BAIDU,
            pattern_id: patternId,
            direction_type: ring.type,
            direction_label: ring.label,
            first_train: weekArrayJinan(first ?? null),
            last_train: weekArrayJinan(last ?? null),
            extras: { line_short_name: short, calendar: 'all_days' }
          });
        }
      }
      continue;
    }

    const { rows: linearRows, swapped } = fixLinearRowDirection(
      rows.filter((r): r is LinearStationTimes => !isLoopTimes(r))
    );
    if (swapped) {
      console.log(`    ${short}: swapped mirrored up/down timetable columns`);
    }
    const serviceNote = LINE_SERVICE_NOTES[short];
    for (let i = 0; i < amapStations.length; i++) {
      const row = linearRows[i];
      if (!row) continue;
      const phys = physList[i]!;
      const stopId = stopIds[i]!;
      const downFirst = weekArrayJinan(row.downFirst ?? null);
      const downLast = weekArrayJinan(row.downLast ?? null);
      const upFirst = weekArrayJinan(row.upFirst ?? null);
      const upLast = weekArrayJinan(row.upLast ?? null);

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
            extras: {
              line_short_name: short,
              calendar: 'all_days',
              ...(serviceNote ? { service_note: serviceNote } : {})
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
            source_id: TT_SOURCE_BAIDU,
            destination_stop_id: destUp,
            origin_stop_id: destDown,
            pattern_id: patternId,
            direction_type: 'linear',
            direction_label: 'up',
            first_train: upFirst,
            last_train: upLast,
            extras: {
              line_short_name: short,
              calendar: 'all_days'
            }
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
    name: '济南轨道交通',
    names: { zh: '济南轨道交通', en: 'Jinan Rail Transit' },
    city: placeholderCity('CN-3701'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/坐标/英文名来自 AMap Subway（官网仅发布图片版线网图、时刻表与票价表，无结构化接口）；首末班来自百度路径规划（directionlite transit），每次同步实时查询，云巴环线按外环/内环收割；8号线与4号线共线贯通（邢村立交桥东 0 秒换乘）；济阳线为 2 元单一票制，其余线路按官方里程票制计价。'
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
