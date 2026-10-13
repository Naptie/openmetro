import {
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
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, TianjinSources } from './fetch.js';
import { THROUGH_SERVICE_NOTE, TIANJIN_LINES, type TianjinLineConfig } from './lines.js';
import { type AlignmentIndexEntry, buildTianjinTimetables } from './timetables.js';

const NETWORK_ID = 'cn-tianjin';
const AMAP_SOURCE = 'amap-subway-1200';

export interface TianjinCanonical {
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
 * AMap drops the 梅江 prefix from the 6号线 station's English
 * (`HUIZHANZHONGXIN`), colliding with the 9号线 会展中心 station id. The
 * operator's own romanisation (cf. 7号线 梅江会展中心南 =
 * MEIJIANGHUIZHANZHONGXINNAN) keeps the full pinyin.
 */
export const STATION_EN_OVERRIDES: Record<string, string> = {
  梅江会展中心: 'Meijianghuizhanzhongxin'
};

function lineIdOf(cfg: TianjinLineConfig): string {
  return `${NETWORK_ID}-line-${cfg.slug}`;
}

function stopIdOf(stationId: string, slug: string): string {
  return `${stationId}-${slug}`;
}

/** All AMap entries per `ln` — 4号线 and 6号线 publish two entries each. */
function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine[]> {
  const out = new Map<string, AmapLine[]>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln) continue;
    const list = out.get(ln) ?? [];
    list.push(line);
    out.set(ln, list);
  }
  return out;
}

function pickAmapEntry(
  entries: AmapLine[] | undefined,
  firstStation: string
): AmapLine | undefined {
  if (!entries) return undefined;
  const fold = foldStationName(firstStation);
  return entries.find((e) => foldStationName(String(e.st?.[0]?.n ?? '')) === fold);
}

export function normalizeTianjin(input: TianjinSources): TianjinCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  const lineRecordByShort = new Map<string, LineEncoded>();

  for (const cfg of TIANJIN_LINES) {
    const entries = amapByName.get(cfg.amapName);
    const anyEntry = entries?.[0];
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    const extras: Record<string, unknown> = {
      names_source: 'source',
      amap_color: anyEntry?.cl,
      amap_name: cfg.amapName
    };
    if (cfg.serviceNote) extras.service_note = cfg.serviceNote;
    if (cfg.short === '津静线') extras.through_service = THROUGH_SERVICE_NOTE;
    lineRecordByShort.set(cfg.short, {
      id: lineIdOf(cfg),
      name: cfg.name,
      names: { zh: cfg.name, en: nameEn },
      aliases: anyEntry?.kn && anyEntry.kn !== cfg.name ? [String(anyEntry.kn)] : [],
      color: hexToCss(anyEntry?.cl),
      short_name: cfg.short,
      mode: cfg.mode,
      status: 'operating',
      loop: cfg.loop,
      source_ids: [
        { source: AMAP_SOURCE, id: cfg.amapName },
        ...String(anyEntry?.li ?? '')
          .split('|')
          .filter(Boolean)
          .map((id) => ({ source: AMAP_SOURCE, id }))
      ],
      extras
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
  const segmentKeys = new Set<string>();
  const alignmentIndex = new Map<string, AlignmentIndexEntry>();
  const stopIdByStation = new Map<string, Map<string, string>>();
  const stationIdByStation = new Map<string, Map<string, string>>();

  const pushSegment = (lineId: string, a: StopEncoded, b: StopEncoded, source: string): void => {
    const key = [a.id, b.id].sort().join('|');
    if (segmentKeys.has(key)) return;
    segmentKeys.add(key);
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

  for (const cfg of TIANJIN_LINES) {
    const lineId = lineIdOf(cfg);
    const entries = amapByName.get(cfg.amapName);
    const stopsOfLine = new Map<string, string>();
    const stationsOfLine = new Map<string, string>();
    /** Alignment key → its ordered AMap station names (for slice patterns). */
    const stationNamesByKey = new Map<string, string[]>();

    const buildStops = (names: string[], h5Name: string): string[] => {
      const stopIds: string[] = [];
      // A split line's stop ids are shared across its alignments, so sequence
      // numbers must be unique per line: offset each alignment past the ones
      // already placed (4号线南/北段 have no shared stops).
      const seqBase = stopsOfLine.size;
      for (let i = 0; i < names.length; i++) {
        const phys = ensurePhys(names[i]!);
        phys.lineNames.add(cfg.name);
        const id = stopIdOf(phys.id, cfg.slug);
        if (!stopById.has(id)) {
          stopById.set(id, {
            id,
            station_id: phys.id,
            line_id: lineId,
            sequence: seqBase + i,
            is_terminal: !cfg.loop && (i === 0 || i === names.length - 1),
            source_id: names[i]!,
            schematic: phys.schematic
              ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
              : undefined,
            extras: {
              line_short_name: cfg.short,
              amap_order: i,
              alignment: h5Name
            }
          });
        }
        stopsOfLine.set(foldStationName(names[i]!), id);
        stationsOfLine.set(foldStationName(names[i]!), phys.id);
        stopIds.push(id);
      }
      return stopIds;
    };

    for (const alignment of cfg.alignments) {
      let names: string[];
      if (alignment.sliceOf && alignment.sliceStations) {
        const base = stationNamesByKey.get(alignment.sliceOf);
        if (!base) {
          throw new Error(
            `alignment ${alignment.h5Name} slices ${alignment.sliceOf} before it ran`
          );
        }
        const from = base.indexOf(alignment.sliceStations[0]);
        const to = base.indexOf(alignment.sliceStations[1]);
        if (from < 0 || to < 0 || to < from) {
          throw new Error(
            `alignment ${alignment.h5Name}: slice ${alignment.sliceStations.join('→')} not contiguous in ${alignment.sliceOf}`
          );
        }
        names = base.slice(from, to + 1);
        // A timetable-only variant rides its base alignment's tracks.
        if (alignment.timetableOnly) {
          const baseAlignment = cfg.alignments.find((a) => a.key === alignment.sliceOf);
          const basePatternId = `${NETWORK_ID}-pattern-${cfg.slug}-${baseAlignment?.key ?? 'main'}`;
          alignmentIndex.set(alignment.h5Name, {
            line: cfg,
            lineId,
            alignment,
            patternId: basePatternId,
            originName: names[0]!,
            terminalName: names[names.length - 1]!
          });
          continue;
        }
      } else {
        const amap = pickAmapEntry(entries, alignment.amapFirstStation ?? '');
        if (!amap) {
          throw new Error(
            `AMap entry not found for ${cfg.amapName} (${alignment.h5Name}, first ${alignment.amapFirstStation})`
          );
        }
        names = (amap.st ?? []).map((s) => String(s.n ?? '').trim()).filter((n) => n.length > 0);
        if (names.length < 2) {
          throw new Error(`AMap station list empty for ${alignment.h5Name}`);
        }
      }
      stationNamesByKey.set(alignment.key, names);

      const stopIds = buildStops(names, alignment.h5Name);

      const originName = names[0]!;
      const terminalName = names[names.length - 1]!;
      const patternId = `${NETWORK_ID}-pattern-${cfg.slug}-${alignment.key}`;
      patterns.push({
        id: patternId,
        line_id: lineId,
        name: alignment.labelZh,
        names: { zh: alignment.labelZh, en: alignment.labelEn },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0]!,
        terminal_stop_id: stopIds[stopIds.length - 1]!,
        is_primary: alignment.isPrimary,
        junction_stop_id: alignment.junctionStation
          ? stopsOfLine.get(foldStationName(alignment.junctionStation))
          : undefined,
        source_ids: [{ source: AMAP_SOURCE, id: alignment.h5Name }],
        extras: {
          line_short_name: cfg.short,
          alignment: alignment.h5Name,
          ...(alignment.junctionStation ? { junction_station: alignment.junctionStation } : {})
        }
      });
      alignmentIndex.set(alignment.h5Name, {
        line: cfg,
        lineId,
        alignment,
        patternId,
        originName,
        terminalName
      });

      for (let i = 0; i + 1 < stopIds.length; i++) {
        pushSegment(
          lineId,
          stopById.get(stopIds[i]!)!,
          stopById.get(stopIds[i + 1]!)!,
          AMAP_SOURCE
        );
      }
    }

    stopIdByStation.set(cfg.slug, stopsOfLine);
    stationIdByStation.set(cfg.slug, stationsOfLine);
  }

  // ---------------------------------------------------------------------------
  // First/last trains from the official H5 timetable app
  // ---------------------------------------------------------------------------
  const stationIdByStop = new Map<string, string>();
  for (const stop of stopById.values()) stationIdByStop.set(stop.id, stop.station_id);
  const timetables = buildTianjinTimetables(input.h5Lines, {
    byAlignment: alignmentIndex,
    stopIdByStation,
    stationIdByStop,
    stationIdByStation
  });

  const stops: StopEncoded[] = [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id));

  const usedStationIds = new Set(stops.map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  for (const phys of physByFold.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    const location = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
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
    name: '天津轨道交通',
    names: { zh: '天津轨道交通', en: 'Tianjin Rail Transit' },
    city: placeholderCity('CN-12'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/坐标/英文名来自 AMap Subway 数据集；首末班车来自官方“运营时刻表”H5 应用（tjgdjt.com 运营服务栏目，static-app.trtpazyz.com）内嵌的逐站两向首末班车数据。4号线南/北段、6号线主线/二期、9号线全线/区间按官方时刻表分列走向。票价按乘坐区间数计价（≤4区间2元、≤9区间3元、≤15区间4元、≥16区间5元，1-11号线与Z4线、津静线及9号线市区段同网）；9号线滨海段（中山门—东海路）独立计价，跨段乘距为网络段票价与滨海段票价之和。除9号线、11号线、Z4线外每周五晚延长运营30分钟。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: filteredTimetables,
    officialLocations: new Map(
      stations
        .filter((s) => s.location)
        .map((s) => [s.id, { lon: s.location!.lon, lat: s.location!.lat, crs: 'gcj02' as const }])
    )
  };
}

/** Folded-name helper re-exported for fare-tool consumers. */
export { foldStationName };
