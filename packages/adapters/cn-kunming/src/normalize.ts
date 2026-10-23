/**
 * Normalization for Kunming Rail Transit: AMap subway dataset + AMap metro
 * planner harvest → canonical records.
 *
 * The module runs in two phases because the harvest needs canonical ids:
 *
 * 1. `buildKunmingTopology` reads the AMap dataset and produces the lines,
 *    stations, stops, patterns and segments — plus the per-alignment context
 *    the planner harvest needs.
 * 2. `normalizeKunming` folds the harvest back in (segment run times, ride
 *    lengths, geometries and the first/last windows).
 *
 * ## Topology
 *
 * AMap publishes seven line *entries* for six operating lines: Line 1 appears
 * twice, once for the main alignment (环城南路 → 大学城南·云南开放大学) and
 * once for the branch that diverges at 春融街 and runs to 昆明南火车站. The
 * two entries share their first 13 stations, so the canonical model gets
 *
 * - one `Line` record for 1号线 with
 * - two `Pattern` records (primary + branch, junction = 春融街),
 *
 * which is exactly the "one primary pattern plus optional branch patterns"
 * shape the repository's topology model expects. Segments are then the union
 * of the consecutive stop pairs of every pattern, so the junction gets its
 * three-way adjacency instead of a phantom bridge.
 *
 * ## Station identity
 *
 * AMap splits 环城南路 into two records (one per line, each with its own
 * disambiguating suffix) although it is a single physical station, so
 * stations are merged on a folded name. AMap also appends landmarks to a few
 * names (金桂街·斗南花市, 庄家塘立交桥, 市级行政中心清风); `lines.ts` carries
 * the corrections back to the operator's published names.
 */
import {
  cleanTime,
  foldStationName,
  hasValidTimes,
  hexToCss,
  isUsableEnglish,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  placeholderCity,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded,
  titleCaseRoman
} from '@openmetro/core';

import type { AmapLine, AmapStation, AmapSubwayDoc, PlannerStation } from './fetch.js';
import {
  CALENDAR_NOTE,
  KUNMING_LINES,
  type KunmingPatternSpec,
  STATION_NAME_OVERRIDES,
  THROUGH_RUN_LINE_PAIRS
} from './lines.js';
import type { HarvestedSegmentMetric, HarvestedService, LinePatternHarvest } from './times.js';

const NETWORK_ID = 'cn-kunming';
export const AMAP_SOURCE = 'amap-subway-5301';
export const PLANNER_SOURCE = 'amap-metro-planner';
export const PLANNER_TIMETABLE_SOURCE = 'amap-metro-planner-timetable';

export interface KunmingCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

/**
 * Fold an AMap station name onto the operator's published station name.
 *
 * AMap appends the exits or a neighbouring landmark to some stations, and
 * splits 环城南路 across two records with different suffixes. Parenthesised
 * and `·`-separated annotations are dropped; the explicit overrides in
 * `lines.ts` handle the remaining cases.
 */
export function foldAmapStationName(raw: string): string {
  const override = STATION_NAME_OVERRIDES[raw];
  const base = override?.zh ?? raw;
  // Drop a parenthesised annotation: 环城南路(北部汽车站) → 环城南路.
  const withoutParens = base.replace(/[（(][^)）]*[)）]/g, '');
  // Drop a `·`-separated landmark: 金桂街·斗南花市 → 金桂街.
  const withoutDot = withoutParens.split('·')[0] ?? withoutParens;
  return foldStationName(withoutDot).trim();
}

function lineIdOf(short: string): string {
  return `${NETWORK_ID}-line-${short}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

function patternIdOf(short: string, role: string): string {
  return `${NETWORK_ID}-pattern-${short}-${role}`;
}

function resolveEnglishName(st: AmapStation, zh: string): string | undefined {
  const override = STATION_NAME_OVERRIDES[zh]?.en ?? STATION_NAME_OVERRIDES[st.n ?? '']?.en;
  if (override) return override;
  const multilang = String(st.multilang?.n?.en ?? '').trim();
  if (isUsableEnglish(multilang)) return titleCaseRoman(stripAnnotation(multilang));
  const legacy = String(st.en ?? '').trim();
  if (isUsableEnglish(legacy)) return titleCaseRoman(stripAnnotation(legacy));
  return undefined;
}

/**
 * Drop AMap's disambiguating annotation from an English name.
 *
 * `Huancheng South Road (Beibu Station)` → `Huancheng South Road`. The
 * annotation identifies the AMap record, not the station.
 */
function stripAnnotation(raw: string): string {
  const open = raw.indexOf('(');
  if (open < 0) return raw.trim();
  return raw.slice(0, open).trim();
}

/** AMap entries grouped by their `ln` value. */
function entriesByLineName(amap: AmapSubwayDoc): Map<string, AmapLine[]> {
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

/**
 * Pick the AMap entry that implements a given service pattern.
 *
 * Line 1's two entries are told apart by their terminal station; the
 * single-pattern lines have exactly one entry. When the configured terminal
 * no longer matches (AMap renamed a station), the entry with the most
 * stations is taken as the primary alignment and the other as the branch —
 * Line 1's main line is the longer of the two.
 */
function pickEntry(entries: AmapLine[], spec: KunmingPatternSpec): AmapLine | undefined {
  if (entries.length === 1) return entries[0];
  if (spec.terminalAmapName) {
    for (const entry of entries) {
      const last = entry.st?.[entry.st.length - 1];
      if (last && String(last.n ?? '').trim() === spec.terminalAmapName) return entry;
    }
  }
  const byLength = [...entries].sort((a, b) => (b.st?.length ?? 0) - (a.st?.length ?? 0));
  return spec.role === 'primary' ? byLength[0] : byLength[byLength.length - 1];
}

/** One service pattern (alignment) of a line, ready for the planner harvest. */
export interface KunmingAlignment {
  role: 'primary' | 'branch';
  /** AMap station names, in order. */
  amapNames: string[];
  /** Canonical station ids, in order. */
  stationIds: string[];
  /** Stop ids, in order. */
  stopIds: string[];
  /** Planner references, in order. */
  plannerStations: PlannerStation[];
}

export interface KunmingTopology {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Per line short: its alignments, in publication order. */
  alignmentsByLine: Map<string, KunmingAlignment[]>;
  /** AMap station name → canonical station id. */
  stationIdByAmapName: Map<string, string>;
}

/**
 * Phase 1: read the AMap dataset and build the canonical topology.
 *
 * Throws when the source does not look like Kunming's network — the adapter
 * must never write a half-empty dataset.
 */
export function buildKunmingTopology(amap: AmapSubwayDoc): KunmingTopology {
  const byLineName = entriesByLineName(amap);

  // ── Physical stations ─────────────────────────────────────────────────────
  const stationsByFold = new Map<
    string,
    {
      stationId: string;
      zh: string;
      amapName: string;
      poiid: string;
      lon?: number;
      lat?: number;
      schematic?: { x: number; y: number };
      pinyin?: string;
      en?: string;
      lines: Set<string>;
    }
  >();
  const stationIdByAmapName = new Map<string, string>();
  const stationByAmapName = new Map<
    string,
    {
      stationId: string;
      zh: string;
      amapName: string;
      poiid: string;
      lon?: number;
      lat?: number;
      schematic?: { x: number; y: number };
      pinyin?: string;
      en?: string;
      lines: Set<string>;
    }
  >();

  const ensureStation = (rawName: string, source: AmapStation) => {
    const amapName = rawName.trim();
    const existing = stationByAmapName.get(amapName);
    if (existing) return existing;

    const zh = foldAmapStationName(amapName);
    let station = stationsByFold.get(zh);
    if (!station) {
      const pinyin = String(source.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(source, zh);
      const [lon, lat] = String(source.sl ?? '')
        .split(',')
        .map((v) => Number(v));
      const pixel = String(source.p ?? '')
        .split(/\s+/)
        .map((v) => Number(v));
      station = {
        stationId: `${NETWORK_ID}-${stationIdFor(en, zh, pinyin)}`,
        zh,
        amapName,
        poiid: String(source.poiid ?? ''),
        lon: Number.isFinite(lon) && Number.isFinite(lat) ? lon : undefined,
        lat: Number.isFinite(lon) && Number.isFinite(lat) ? lat : undefined,
        schematic:
          pixel.length === 2 && Number.isFinite(pixel[0]) && Number.isFinite(pixel[1])
            ? { x: pixel[0], y: pixel[1] }
            : undefined,
        pinyin,
        en,
        lines: new Set()
      };
      stationsByFold.set(zh, station);
    }
    stationByAmapName.set(amapName, station);
    stationIdByAmapName.set(amapName, station.stationId);
    return station;
  };

  // ── Lines ────────────────────────────────────────────────────────────────
  const lines: LineEncoded[] = [];
  const lineIdByShort = new Map<string, string>();

  for (const cfg of KUNMING_LINES) {
    const entries = byLineName.get(cfg.amapName) ?? [];
    if (entries.length === 0) throw new Error(`AMap has no entry for ${cfg.amapName}`);
    const lineId = lineIdOf(cfg.short);
    lineIdByShort.set(cfg.short, lineId);
    const primaryEntry = pickEntry(entries, cfg.patterns[0]!);

    lines.push({
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: cfg.nameEn },
      aliases: cfg.patterns.length > 1 ? [`${cfg.name}支线`] : [],
      color: hexToCss(primaryEntry?.cl),
      short_name: cfg.short,
      mode: 'metro',
      status: 'operating',
      loop: false,
      source_ids: entries.map((e) => ({ source: AMAP_SOURCE, id: String(e.ls ?? e.ln ?? '') })),
      extras: {
        names_source: 'source',
        amap_color: primaryEntry?.cl,
        amap_name: cfg.amapName,
        planner_vehicle_name: cfg.plannerName,
        ...(cfg.patterns.length > 1 ? { service_patterns: cfg.patterns.length } : {})
      }
    });
  }

  // ── Stops, patterns, segments ────────────────────────────────────────────
  const stopsById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segmentsByPair = new Map<string, SegmentEncoded>();
  const alignmentsByLine = new Map<string, KunmingAlignment[]>();
  /**
   * Stop records are created once the terminals are known: a stop ends an
   * alignment when it is that alignment's first or last stop.
   */
  interface PendingStop {
    stopId: string;
    stationId: string;
    lineId: string;
    sequence: number;
    short: string;
    amapOrder: number;
    amapStationId?: string;
    sourceId: string;
    schematic?: { x: number; y: number };
  }
  const pendingStops = new Map<string, PendingStop>();
  /** Station → sequence, per line. Branch-only stations continue the count. */
  const sequenceByLine = new Map<string, Map<string, number>>();

  for (const cfg of KUNMING_LINES) {
    const lineId = lineIdByShort.get(cfg.short)!;
    const entries = byLineName.get(cfg.amapName) ?? [];
    const alignments: KunmingAlignment[] = [];

    for (const spec of cfg.patterns) {
      const entry = pickEntry(entries, spec);
      if (!entry) throw new Error(`AMap entry for ${cfg.name} ${spec.role} not found`);
      const rawStations = (entry.st ?? [])
        .map((s) => ({ raw: String(s.n ?? '').trim(), source: s }))
        .filter((s) => s.raw.length > 0);
      if (rawStations.length < 2) {
        throw new Error(
          `AMap entry for ${cfg.name} ${spec.role} has ${rawStations.length} stations`
        );
      }

      const alignment: KunmingAlignment = {
        role: spec.role,
        amapNames: [],
        stationIds: [],
        stopIds: [],
        plannerStations: []
      };

      for (let i = 0; i < rawStations.length; i++) {
        const { raw, source } = rawStations[i]!;
        const station = ensureStation(raw, source);
        station.lines.add(cfg.short);
        alignment.amapNames.push(raw);
        alignment.stationIds.push(station.stationId);
        alignment.plannerStations.push({
          name: raw,
          lon: station.lon ?? 0,
          lat: station.lat ?? 0,
          poiid: station.poiid
        });

        const stopId = stopIdOf(station.stationId, cfg.short);
        alignment.stopIds.push(stopId);
        if (!pendingStops.has(stopId)) {
          /**
           * `stop.sequence` must be unique within a line. The primary
           * alignment takes 0…n-1; a branch that owns stations the primary
           * does not (Line 1's 支线 to 昆明南站) continues the count — the same
           * treatment cn-chengdu and cn-chongqing give their branches.
           */
          const sequences = sequenceByLine.get(cfg.short) ?? new Map<string, number>();
          sequenceByLine.set(cfg.short, sequences);
          let sequence = sequences.get(station.stationId);
          if (sequence == null) {
            sequence = sequences.size;
            sequences.set(station.stationId, sequence);
          }
          pendingStops.set(stopId, {
            stopId,
            stationId: station.stationId,
            lineId,
            sequence,
            short: cfg.short,
            amapOrder: i,
            amapStationId: source.sid,
            // AMap's per-line station code (`si`) is the closest thing to an
            // official stop code the network publishes.
            sourceId: String(source.si ?? source.sid ?? raw),
            schematic: station.schematic
          });
        }
      }

      alignments.push(alignment);
    }

    // The junction is the last station every alignment of the line shares.
    let junctionStationId: string | undefined;
    if (alignments.length > 1) {
      const first = alignments[0]!;
      let shared = 0;
      for (let i = 0; i < first.stationIds.length; i++) {
        const id = first.stationIds[i]!;
        if (alignments.every((a) => a.stationIds[i] === id)) shared = i + 1;
        else break;
      }
      junctionStationId = shared > 0 ? first.stationIds[shared - 1] : undefined;
      if (junctionStationId && cfg.junction) {
        const computed = alignments[0]!.amapNames[shared - 1];
        if (computed !== cfg.junction) {
          console.log(
            `    ${cfg.name}: junction computed as ${computed}, expected ${cfg.junction}`
          );
        }
      }
    }

    /**
     * A branch alignment starts at the junction.
     *
     * The repository's pattern model expects two alignments of a line to
     * share exactly one stop — the junction — and a branch to run from there
     * to its own terminal (cn-chengdu, cn-chongqing and cn-guangzhou all
     * model their branches this way). Line 1's 支线 therefore covers
     * 春融街 → 宜和路 → … → 昆明南站, while the trunk 环城南路 → … → 春融街
     * stays on the primary alignment and the two meet at the junction.
     */
    for (const alignment of alignments) {
      if (alignment.role === 'primary' || !junctionStationId) continue;
      const at = alignment.stationIds.indexOf(junctionStationId);
      if (at <= 0) continue;
      alignment.amapNames = alignment.amapNames.slice(at);
      alignment.stationIds = alignment.stationIds.slice(at);
      alignment.stopIds = alignment.stopIds.slice(at);
      alignment.plannerStations = alignment.plannerStations.slice(at);
    }

    for (const alignment of alignments) {
      const junctionStopId = junctionStationId ? stopIdOf(junctionStationId, cfg.short) : undefined;
      const origin = alignment.amapNames[0]!;
      const terminal = alignment.amapNames[alignment.amapNames.length - 1]!;
      patterns.push({
        id: patternIdOf(cfg.short, alignment.role),
        line_id: lineId,
        name: `${origin} → ${terminal}`,
        names: { zh: `${origin}→${terminal}`, en: `${origin} to ${terminal}` },
        stop_ids: alignment.stopIds,
        origin_stop_id: alignment.stopIds[0]!,
        terminal_stop_id: alignment.stopIds[alignment.stopIds.length - 1]!,
        is_primary: alignment.role === 'primary',
        ...(alignment.role === 'branch' && junctionStopId
          ? { junction_stop_id: junctionStopId }
          : {}),
        source_ids: [{ source: AMAP_SOURCE, id: cfg.amapName }],
        extras: {
          line_short_name: cfg.short,
          pattern_role: alignment.role,
          ...(cfg.junction ? { junction_station: cfg.junction } : {})
        }
      });

      // Segments: the union of the consecutive stop pairs of every alignment.
      for (let i = 0; i + 1 < alignment.stopIds.length; i++) {
        const a = alignment.stopIds[i]!;
        const b = alignment.stopIds[i + 1]!;
        const key = [a, b].sort().join('|');
        if (segmentsByPair.has(key)) continue;
        const stopA = pendingStops.get(a)!;
        const stopB = pendingStops.get(b)!;
        segmentsByPair.set(key, {
          id: `${NETWORK_ID}-seg-${a}-${b}`,
          line_id: lineId,
          from_stop_id: a,
          to_stop_id: b,
          from_station_id: stopA.stationId,
          to_station_id: stopB.stationId,
          direction: 'both',
          source_id: PLANNER_SOURCE
        });
      }
    }

    alignmentsByLine.set(cfg.short, alignments);
  }

  // Termini: a stop is terminal when it ends an alignment of its line.
  const terminalStopIds = new Set<string>();
  for (const pattern of patterns) {
    terminalStopIds.add(pattern.origin_stop_id);
    terminalStopIds.add(pattern.terminal_stop_id);
  }

  for (const pending of pendingStops.values()) {
    stopsById.set(pending.stopId, {
      id: pending.stopId,
      station_id: pending.stationId,
      line_id: pending.lineId,
      sequence: pending.sequence,
      is_terminal: terminalStopIds.has(pending.stopId),
      source_id: pending.sourceId,
      schematic: pending.schematic
        ? { x: pending.schematic.x, y: pending.schematic.y, crs: 'schematic' as const }
        : undefined,
      extras: {
        line_short_name: pending.short,
        amap_order: pending.amapOrder,
        amap_station_id: pending.amapStationId
      }
    });
  }

  // ── Stations ─────────────────────────────────────────────────────────────
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const usedStationIds = new Set([...stopsById.values()].map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  for (const station of stationsByFold.values()) {
    if (!usedStationIds.has(station.stationId)) continue;
    const location =
      station.lon != null && station.lat != null
        ? { lon: station.lon, lat: station.lat, crs: 'gcj02' as const }
        : undefined;
    if (location) officialLocations.set(station.stationId, location);
    stations.push({
      id: station.stationId,
      name: station.zh,
      names: { zh: station.zh, en: station.en || station.zh },
      location,
      schematic: station.schematic
        ? { x: station.schematic.x, y: station.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [
        { source: AMAP_SOURCE, id: station.amapName },
        ...(station.poiid ? [{ source: AMAP_SOURCE, id: station.poiid }] : [])
      ],
      extras: {
        pinyin: station.pinyin,
        lines: [...station.lines].sort(),
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: station.en && station.en !== station.zh ? 'source' : 'derived',
        ...(station.amapName !== station.zh ? { amap_name: station.amapName } : {})
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '昆明轨道交通',
    names: { zh: '昆明轨道交通', en: 'Kunming Rail Transit' },
    city: placeholderCity('CN-5301'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '官网 www.kmgdgs.com 已不可用（WAF 挑战 + CMS 后端 502，且 2021 年起该域名只剩「昆明志愿者网」栏目），' +
      '官方时刻表与票价表历史上也只以图片发布，故不做 OCR。' +
      '拓扑、坐标、英文名、线色、示意图来自 AMap 地铁数据集 5301（103 座物理车站 / 115 条线-站记录，坐标与英文名 100% 覆盖）；' +
      '区间行车时间、里程、区间几何与逐站逐交路首末班车来自 AMap 地铁规划器 busExt（与百度 Direction v2 独立复核，时刻逐值一致）；' +
      'OD 票价按官方里程阶梯票制（4/8/13/19/26/34/43 km 分档，2 元起步）计算。' +
      '1 号线在春融街分叉出至昆明南站的支线，并与 2 号线在环城南路贯通运营。'
  };

  return {
    network,
    lines: lines.sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops: [...stopsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: [...segmentsByPair.values()].sort((a, b) => a.id.localeCompare(b.id)),
    officialLocations,
    alignmentsByLine,
    stationIdByAmapName
  };
}

/**
 * Map a planner service label onto the service pattern it belongs to.
 *
 * The label names both ends of the service (`A--B`), so the direction follows
 * from which end of the alignment the service heads to: `A` = the alignment's
 * origin ⇒ `down`, `B` = the alignment's terminal ⇒ `up`.
 *
 * When the label does not match one of the line's alignments — which happens
 * at 环城南路, where Lines 1 and 2 are through connected and the planner
 * answers with the neighbouring line's service — the attribution falls back
 * to the topology: the query ran along an alignment towards one of its ends,
 * so the train the passenger boards heads that way.
 */
function matchServiceToPattern(
  alignments: { amapNames: string[]; role: 'primary' | 'branch' }[],
  service: HarvestedService
): {
  alignment: { amapNames: string[]; role: 'primary' | 'branch' };
  direction: 'down' | 'up';
} | null {
  for (const alignment of alignments) {
    const origin = alignment.amapNames[0];
    const terminal = alignment.amapNames[alignment.amapNames.length - 1];
    if (service.origin === origin && service.destination === terminal) {
      return { alignment, direction: 'down' };
    }
    if (service.origin === terminal && service.destination === origin) {
      return { alignment, direction: 'up' };
    }
  }
  const byRole = alignments.find((a) => a.role === service.queryRole);
  if (!byRole) return null;
  return { alignment: byRole, direction: service.queryDirection };
}

/**
 * Phase 2: fold the planner harvest into the topology.
 *
 * The segment metrics become `travel_time_source: 'source'` (the planner
 * reports the operator's run time), and each service window becomes one
 * canonical timetable row keyed by station × pattern × direction.
 */
export function normalizeKunming(
  topology: KunmingTopology,
  harvest: LinePatternHarvest[]
): KunmingCanonical {
  const { network, lines, stations, stops, patterns } = topology;

  // ── Segment metrics ──────────────────────────────────────────────────────
  const metricByPair = new Map<string, HarvestedSegmentMetric>();
  for (const lineHarvest of harvest) {
    for (const metric of lineHarvest.segments) {
      const key = [metric.from_stop_id, metric.to_stop_id].sort().join('|');
      if (!metricByPair.has(key)) metricByPair.set(key, metric);
    }
  }
  const segments: SegmentEncoded[] = topology.segments.map((seg) => {
    const metric = metricByPair.get([seg.from_stop_id, seg.to_stop_id].sort().join('|'));
    if (!metric) return seg;
    return {
      ...seg,
      travel_time_seconds: metric.travel_time_seconds,
      travel_time_source: metric.travel_time_seconds ? ('source' as const) : undefined,
      distance_km: metric.distance_km,
      geometry: metric.geometry,
      source_id: PLANNER_SOURCE,
      extras: {
        ...(metric.extras ?? {}),
        distance_source: metric.distance_km != null ? 'planner' : undefined
      }
    };
  });

  // ── First/last windows ───────────────────────────────────────────────────
  const timetables: TimetableEncoded[] = [];
  const seenTimetableIds = new Set<string>();

  for (const lineHarvest of harvest) {
    const cfg = KUNMING_LINES.find((l) => l.short === lineHarvest.short);
    if (!cfg) continue;
    const lineId = `${NETWORK_ID}-line-${cfg.short}`;
    const alignments = topology.alignmentsByLine.get(cfg.short) ?? [];

    for (const service of lineHarvest.services) {
      const stationId = topology.stationIdByAmapName.get(service.amapName);
      if (!stationId) continue;
      const first = cleanTime(service.first);
      const last = cleanTime(service.last);
      if (!first && !last) continue;

      const match = matchServiceToPattern(alignments, service);
      if (!match) continue;

      // The destination is the end of the matched alignment the service heads
      // to, so it stays inside this line's topology even when the planner
      // answered with a neighbouring line's service.
      const destinationName =
        match.direction === 'down'
          ? match.alignment.amapNames[match.alignment.amapNames.length - 1]
          : match.alignment.amapNames[0];
      const originName =
        match.direction === 'down'
          ? match.alignment.amapNames[0]
          : match.alignment.amapNames[match.alignment.amapNames.length - 1];
      const destinationId = destinationName
        ? topology.stationIdByAmapName.get(destinationName)
        : undefined;
      const originId = originName ? topology.stationIdByAmapName.get(originName) : undefined;

      const id = `${NETWORK_ID}-tt-${stationId}-${cfg.short}-${match.alignment.role}-${match.direction}`;
      if (seenTimetableIds.has(id)) continue;
      seenTimetableIds.add(id);

      timetables.push({
        id,
        station_id: stationId,
        stop_id: stopIdOf(stationId, cfg.short),
        line_id: lineId,
        source_id: PLANNER_TIMETABLE_SOURCE,
        destination_stop_id: destinationId ? stopIdOf(destinationId, cfg.short) : undefined,
        origin_stop_id: originId ? stopIdOf(originId, cfg.short) : undefined,
        pattern_id: `${NETWORK_ID}-pattern-${cfg.short}-${match.alignment.role}`,
        direction_type: 'linear',
        direction_label: match.direction,
        first_train: first ? [first] : [],
        last_train: last ? [last] : [],
        extras: {
          line_short_name: cfg.short,
          pattern_role: match.alignment.role,
          calendar: CALENDAR_NOTE,
          ...(service.headway ? { headway: service.headway } : {}),
          ...(service.busname ? { planner_service: service.busname } : {})
        }
      });
    }
  }

  return {
    network,
    lines,
    stations,
    stops,
    patterns,
    segments,
    timetables: timetables.filter((t) => hasValidTimes(t)),
    officialLocations: topology.officialLocations
  };
}

/**
 * Zero-second transfer edges for the through-running lines.
 *
 * Lines 1 and 2 share 环城南路 and a train continues from one to the other
 * without the passenger changing trains, so the shared station gets a
 * zero-second transfer edge in both directions — the same modelling choice
 * cn-jinan makes for its 4/8 through-run.
 */
export function buildThroughRunTransfers(canonical: KunmingCanonical): {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  walk_time_seconds: number;
  is_out_of_station: boolean;
  source_id: string;
}[] {
  const out: ReturnType<typeof buildThroughRunTransfers> = [];
  for (const [a, b] of THROUGH_RUN_LINE_PAIRS) {
    const lineA = canonical.lines.find((l) => l.short_name === a);
    const lineB = canonical.lines.find((l) => l.short_name === b);
    if (!lineA || !lineB) continue;
    const stationsA = new Set(
      canonical.stops.filter((s) => s.line_id === lineA.id).map((s) => s.station_id)
    );
    for (const stopB of canonical.stops.filter((s) => s.line_id === lineB.id)) {
      if (!stationsA.has(stopB.station_id)) continue;
      out.push(
        {
          station_id: stopB.station_id,
          from_line_id: lineA.id,
          to_line_id: lineB.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: 'km-through-run-1-2'
        },
        {
          station_id: stopB.station_id,
          from_line_id: lineB.id,
          to_line_id: lineA.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: 'km-through-run-1-2'
        }
      );
    }
  }
  return out;
}
