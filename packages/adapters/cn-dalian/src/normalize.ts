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
import type { AmapLine, AmapStation, AmapSubwayDoc, DalianSources } from './fetch.js';
import {
  DALIAN_LINES,
  type DalianLineConfig,
  dalianBranchPatternId,
  dalianLineId,
  dalianPrimaryPatternId
} from './lines.js';
import { type HarvestedStationTimes, weekArray } from './timetables.js';

const NETWORK_ID = 'cn-dalian';

const AMAP_SOURCE = 'amap-subway-2102';
const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface DalianCanonical {
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
  // AMap leaves `en` empty for every Dalian station; `multilang.n.en` is the
  // populated field (e.g. 姚家 → "Yaojia", 河口 → "Hekou").
  const multilang = String(st.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(multilang);
  const en = String(st.en ?? '').trim();
  if (isUsableEnglish(en)) return titleCaseRoman(en);
  const fromPinyin = pinyinToEnglish(String(st.sp ?? ''));
  if (fromPinyin) return fromPinyin;
  // Wikidata fillStationEnglishNames in run.ts supplies the rest — never invent names.
  return undefined;
}

/** AMap publishes romanisations in lower case; prose case reads better. */
function titleCaseRoman(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function stopIdOf(stationId: string, key: string): string {
  return `${stationId}-${key}`;
}

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const out = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) out.set(ln, line);
  }
  return out;
}

/** Ordered station names of one AMap entry. */
function amapStationNames(line: AmapLine | undefined): string[] {
  return (line?.st ?? []).map((s) => String(s.n ?? '').trim()).filter((n) => n.length > 0);
}

/**
 * One physical alignment to materialise as a `Pattern`.
 *
 * `stopKey` namespaces **timetable** ids within the line, so the same station
 * keeps one record per service direction it can board (开发区 is both a
 * 金石滩-bound and a 九里-bound boarding point). Stops themselves are NOT
 * namespaced per alignment: the junction station is a single stop shared by the
 * primary pattern and the branch, following the established convention (cf.
 * Shanghai Line 11's 嘉定新城 junction). That keeps the junction reachable in
 * both directions without a same-line transfer edge, which `deriveTransfers`
 * would not generate anyway.
 */
interface Alignment {
  patternId: string;
  ttKey: string;
  names: string[];
  isPrimary: boolean;
  junctionName?: string;
  patternName: string;
  sourceId: string;
  extras: Record<string, unknown>;
}

function buildAlignments(cfg: DalianLineConfig, amapByName: Map<string, AmapLine>): Alignment[] {
  const out: Alignment[] = [];

  const primaryNames = amapStationNames(amapByName.get(cfg.amapName));
  if (primaryNames.length < 2) {
    throw new Error(`AMap station list empty or too short for ${cfg.name} (${cfg.amapName})`);
  }
  out.push({
    patternId: dalianPrimaryPatternId(cfg.short),
    ttKey: cfg.short,
    names: primaryNames,
    isPrimary: true,
    patternName: `${primaryNames[0]} → ${primaryNames[primaryNames.length - 1]}`,
    sourceId: cfg.amapName,
    extras: { line_short_name: cfg.short, alignment: 'main', note: cfg.note }
  });

  for (const branch of cfg.branches ?? []) {
    const raw = amapStationNames(amapByName.get(branch.amapName));
    if (raw.length < 2) {
      throw new Error(`AMap branch list empty or too short for ${cfg.name} (${branch.amapName})`);
    }
    // Orient the branch junction-first so `origin_stop_id` is the divergence
    // point and `junction_stop_id` is a real position on the alignment (AMap
    // lists 地铁3号线支线 as 九里 → 开发区).
    const names = raw[0] === branch.junction ? raw : raw.slice().reverse();
    const junctionIdx = names.indexOf(branch.junction);
    if (junctionIdx < 0) {
      throw new Error(
        `${cfg.name} branch ${branch.amapName}: junction 站点 ${branch.junction} not in AMap list (${raw.join('·')})`
      );
    }
    if (junctionIdx !== 0) {
      console.log(
        `  ${cfg.name} branch ${branch.key}: junction ${branch.junction} at index ${junctionIdx}`
      );
    }
    out.push({
      patternId: dalianBranchPatternId(cfg.short, branch.key),
      ttKey: branch.key,
      names,
      isPrimary: false,
      junctionName: branch.junction,
      patternName: `${names[0]} → ${names[names.length - 1]}`,
      sourceId: branch.amapName,
      extras: {
        line_short_name: cfg.short,
        alignment: 'branch',
        branch_key: branch.key,
        amap_name: branch.amapName,
        junction_station: branch.junction,
        note: branch.note
      }
    });
  }

  return out;
}

/**
 * Station orders of every alignment, in pattern order (origin → terminal).
 *
 * `run.ts` drives the Baidu first/last harvest from this: the core harvest
 * treats the first station as the "up" terminus and the last as the "down"
 * terminus, so the branch being junction-first is what makes its harvest
 * semantics correct.
 */
export function dalianAlignments(sources: DalianSources): {
  patternId: string;
  lineName: string;
  short: string;
  baiduName: string;
  ttKey: string;
  stations: { name: string; lon: number; lat: number }[];
}[] {
  const amapByName = amapLinesByName(sources.amapSubway);
  const out: ReturnType<typeof dalianAlignments> = [];
  for (const cfg of DALIAN_LINES) {
    for (const al of buildAlignments(cfg, amapByName)) {
      const amapLine = amapByName.get(
        al.extras.alignment === 'branch' ? String(al.extras.amap_name) : cfg.amapName
      );
      const byName = new Map(
        (amapLine?.st ?? []).map((s) => [String(s.n ?? '').trim(), s] as const)
      );
      out.push({
        patternId: al.patternId,
        lineName: cfg.name,
        short: cfg.short,
        baiduName: cfg.baiduName,
        ttKey: al.ttKey,
        stations: al.names.map((name) => {
          const st = byName.get(name);
          const loc = parseSlCoord(st?.sl);
          if (!loc) {
            throw new Error(`${cfg.name}: AMap station ${name} has no usable GCJ-02 coordinate`);
          }
          return { name, lon: loc.lon, lat: loc.lat };
        })
      });
    }
  }
  return out;
}

export function normalizeDalian(
  input: DalianSources,
  /** First/last rows keyed by pattern id. */
  harvestedRows: Map<string, HarvestedStationTimes[]>
): DalianCanonical {
  const amapByName = amapLinesByName(input.amapSubway);

  // Every AMap station, indexed by folded name, for identity + coordinate lookup.
  const amapStationByFold = new Map<string, AmapStation>();
  for (const line of input.amapSubway.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (n && !amapStationByFold.has(foldStationName(n))) {
        amapStationByFold.set(foldStationName(n), st);
      }
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

  const lineRecords: LineEncoded[] = [];
  const stopById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  // Segments are the union of consecutive stop pairs across every pattern of a
  // line, so a shared trunk contributes one edge even when several alignments
  // ride it. Keyed undirected because every ride edge serves both directions.
  const pushSegment = (lineId: string, a: StopEncoded, b: StopEncoded): void => {
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
      source_id: AMAP_SOURCE
    });
  };

  for (const cfg of DALIAN_LINES) {
    const lineId = dalianLineId(cfg.short);
    const amap = amapByName.get(cfg.amapName);
    const nameEn = cfg.nameEn || deriveLineEnglishName(cfg.name, cfg.short) || `Line ${cfg.short}`;
    lineRecords.push({
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
        ...(cfg.branches ?? []).map((b) => ({ source: AMAP_SOURCE, id: b.amapName }))
      ],
      extras: {
        names_source: 'source',
        amap_color: amap?.cl,
        amap_name: amap?.ln,
        baidu_vehicle_name: cfg.baiduName,
        note: cfg.note
      }
    });

    // Flat per-line stop counter: the primary alignment numbers 0..n-1 and a
    // branch continues from wherever it left off.
    let nextSequence = 0;

    for (const al of buildAlignments(cfg, amapByName)) {
      const physList: Phys[] = [];
      const stopIds: string[] = [];

      for (let i = 0; i < al.names.length; i++) {
        const zh = al.names[i]!;
        const phys = ensurePhys(zh);
        phys.lineNames.add(cfg.name);
        const id = stopIdOf(phys.id, cfg.short);
        if (!stopById.has(id)) {
          stopById.set(id, {
            id,
            station_id: phys.id,
            line_id: lineId,
            // `sequence` is the stop's position in the line's **flat** source
            // list, so a branch continues the primary's numbering instead of
            // restarting at 0 (which would collide with the trunk). The
            // authoritative adjacency lives in `patterns[].stop_ids`.
            sequence: nextSequence++,
            is_terminal: i === 0 || i === al.names.length - 1,
            source_id: al.sourceId,
            schematic: phys.schematic
              ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
              : undefined,
            extras: {
              line_short_name: cfg.short,
              alignment: al.extras.alignment,
              amap_order: i,
              amap_sid: amapStationByFold.get(foldStationName(zh))?.sid
            }
          });
        }
        physList.push(phys);
        stopIds.push(id);
      }

      const first = al.names[0]!;
      const last = al.names[al.names.length - 1]!;
      const junctionStopId = al.junctionName
        ? stopIdOf(ensurePhys(al.junctionName).id, cfg.short)
        : undefined;
      if (al.junctionName && !stopIds.includes(junctionStopId!)) {
        throw new Error(
          `${cfg.name} branch ${al.ttKey}: junction stop ${junctionStopId} (${al.junctionName}) not on the branch pattern`
        );
      }

      patterns.push({
        id: al.patternId,
        line_id: lineId,
        name: al.patternName,
        names: { zh: `${first}→${last}`, en: `${first} to ${last}` },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0]!,
        terminal_stop_id: stopIds[stopIds.length - 1]!,
        is_primary: al.isPrimary,
        junction_stop_id: junctionStopId,
        source_ids: [{ source: AMAP_SOURCE, id: al.sourceId }],
        extras: { ...al.extras, line_short_name: cfg.short }
      });

      for (let i = 0; i + 1 < stopIds.length; i++) {
        pushSegment(lineId, stopById.get(stopIds[i]!)!, stopById.get(stopIds[i + 1]!)!);
      }

      // ---- first/last trains, harvested per alignment -------------------
      const rows = harvestedRows.get(al.patternId);
      if (!rows?.length) continue;
      const destDown = stopIds[stopIds.length - 1]!;
      const destUp = stopIds[0]!;

      for (let i = 0; i < al.names.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const phys = physList[i]!;
        const stopId = stopIds[i]!;
        const downFirst = weekArray(row.downFirst ?? null);
        const downLast = weekArray(row.downLast ?? null);
        const upFirst = weekArray(row.upFirst ?? null);
        const upLast = weekArray(row.upLast ?? null);

        if (downFirst.length || downLast.length) {
          const id = `${NETWORK_ID}-${phys.id}-${al.ttKey}-down`;
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
              pattern_id: al.patternId,
              direction_type: 'linear',
              direction_label: 'down',
              first_train: downFirst,
              last_train: downLast,
              extras: {
                line_short_name: cfg.short,
                alignment: al.extras.alignment,
                calendar: 'all_days'
              }
            });
          }
        }
        if (upFirst.length || upLast.length) {
          const id = `${NETWORK_ID}-${phys.id}-${al.ttKey}-up`;
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
              pattern_id: al.patternId,
              direction_type: 'linear',
              direction_label: 'up',
              first_train: upFirst,
              last_train: upLast,
              extras: {
                line_short_name: cfg.short,
                alignment: al.extras.alignment,
                calendar: 'all_days'
              }
            });
          }
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
    name: '大连地铁',
    names: { zh: '大连地铁', en: 'Dalian Metro' },
    city: placeholderCity('CN-2102'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 900 },
    notes:
      '拓扑/坐标/英文名/示意图像素/配色全部来自 AMap Subway（2102_drw_dalian），大连无任何官方机读源：原官网 www.dlmetro.com 域名已注销，运营主体重组为大连交通集团后官网 www.dltransgrp.com 仅有企业新闻与公交公告，无时刻表/票价/线路图；乘客侧首末班仅经「大连地铁」APP 与微信小程序以图片分发，故首末班来自百度路径规划（directionlite transit）实时查询，不做 OCR。AMap 把 3号线九里支线单列为「地铁3号线支线」，本数据按分支 pattern（junction 开发区）折回 3号线；开发区站为一岛两侧式三站台，故主 alignment 与支线 alignment 各建一个 stop。票价为里程分段计价（0–6km 2 元，晋级里程 6,6,8,8,10,10,15,15… 公里，54 公里以上每 15 公里加 1 元，全线网单程最高 14 元），由 segments.distance_km 上的最短轨道里程确定性计算，需在段里程采集之后生成。3号线保税区小交路（大连站⇌保税区）与13号线大小交路（普兰店振兴街↔开发区 / 九里↔开发区）为同 alignment 上的服务变体，本模型不含列车等级，仅记录于 notes。'
  };

  return {
    network,
    lines: lineRecords.sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    timetables: filteredTimetables,
    officialLocations
  };
}
