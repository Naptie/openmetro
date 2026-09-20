import {
  applyDerivedTimes,
  applyTimetableServiceStatus,
  deriveSegmentTimes,
  deriveTransfers,
  foldRareCharacters,
  hasValidTimes,
  type LineEncoded,
  lineSlug,
  type NetworkEncoded,
  normalizeTimetableTimes,
  type PatternEncoded,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stripDirectionAnnotation,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';

export interface GzRawInput {
  linestation: { businessObject: GzLineCard[] };
  stationDetails: Record<string, GzStationDetail>;
  servicetimes?: Record<string, GzServiceTime[]>;
}

export interface GzLineCard {
  lineShowCode: string;
  lineId: number;
  lineName: string;
  orderNum: string;
  lineColor: string;
  lineNameEn?: string;
  stations: GzStation[];
}

export interface GzStation {
  isHuanCheng: boolean;
  stationNameEn: string;
  orderNum: number;
  stationName: string;
  stationShowCode: string;
  stationId: number;
  hcLines?: GzHcLine[];
}

export interface GzHcLine {
  lineShowCode: string;
  lineName: string;
  lineNameEn: string;
  lineColor: string;
}

export interface GzStationDetail {
  transfer?: boolean;
  latitude?: number;
  longitude?: number;
  stationRelateId?: string;
  nameCN?: string;
  nameEN?: string;
  open?: boolean;
  mapX?: number;
  mapY?: number;
}

export interface GzServiceTime {
  stationName: string;
  lineCn: string;
  toStationName: string;
  startTime: string;
  endTime: string;
  remark?: string;
}

export interface GzCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /** Raw official getByNameOrCode coords; validated in fillCoordinates. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

const NETWORK_ID = 'cn-guangzhou';
const DEFAULT_SEGMENT_SECONDS = 120;

/**
 * Guangzhou-specific rare-character fold forms. The official GZMTR feed
 * decomposes 𧒽 into the two common glyphs "虫雷" (sometimes spaced); canonical
 * station names use the single codepoint. Core stays city-agnostic, so this
 * table lives here in the adapter.
 */
const RARE_CHAR_FORMS: readonly (readonly [string, string])[] = [['虫雷', '𧒽']];

const fold = (name: string): string => foldRareCharacters(name, RARE_CHAR_FORMS);

function slug(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!out) {
    out = [...Buffer.from(s, 'utf-8')].map((b) => b.toString(16)).join('');
  }
  return out;
}

/** Stable station id: English slug, plus parenthetical Chinese qualifier when present. */
function stationIdFor(en: string | undefined, zh: string): string {
  const base = slug(en || zh);
  const m = /[（(]([^）)]+)[）)]/.exec(zh);
  if (m) {
    const suffix = slug(m[1]);
    if (suffix && !base.endsWith(suffix)) return `${base}-${suffix}`;
  }
  return base;
}

function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^0x/, '').replace(/^#/, '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return undefined;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function ensureUniqueTtId(
  used: Set<string>,
  networkId: string,
  stationId: string,
  lineId: string,
  suffix: string
): string {
  const base = `${networkId}-${stationId}-${slug(lineId)}-${suffix}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-2-${n}`;
    n++;
  }
  used.add(id);
  return id;
}

/** Detect loop direction type from a Guangzhou service time remark or toStationName. */
function detectLoopDirection(
  remark: string | undefined,
  toStationName: string
): 'loop_inner' | 'loop_outer' | undefined {
  const text = `${remark ?? ''} ${toStationName}`;
  if (text.includes('内环')) return 'loop_inner';
  if (text.includes('外环')) return 'loop_outer';
  return undefined;
}

/** The primary card is the one with the shortest orderNum (no branch suffix). */
function primaryCard(cards: GzLineCard[]): GzLineCard {
  return [...cards].sort((a, b) => a.orderNum.length - b.orderNum.length)[0];
}

export function normalize(input: GzRawInput): GzCanonical {
  // Official API writes 𧒽岗 as "虫雷 岗"; canonical names use the single char.
  const foldCards = (cards: GzLineCard[]): GzLineCard[] =>
    cards.map((c) => ({
      ...c,
      stations: c.stations.map((s) => ({
        ...s,
        stationName: fold(s.stationName)
      }))
    }));
  const foldStationDetails = (
    details: Record<string, GzStationDetail>
  ): Record<string, GzStationDetail> => {
    const out: Record<string, GzStationDetail> = {};
    for (const [k, v] of Object.entries(details)) {
      out[fold(k)] = v;
      if (v.nameCN) v.nameCN = fold(v.nameCN);
    }
    return out;
  };
  const foldServiceTimes = (
    times: Record<string, GzServiceTime[]>
  ): Record<string, GzServiceTime[]> => {
    const out: Record<string, GzServiceTime[]> = {};
    for (const [k, recs] of Object.entries(times)) {
      const key = fold(k);
      const mapped = recs.map((r) => ({
        ...r,
        stationName: fold(r.stationName || k),
        toStationName: fold(r.toStationName || '')
      }));
      const existing = out[key];
      out[key] = existing ? [...existing, ...mapped] : mapped;
    }
    return out;
  };

  const cards = foldCards(input.linestation.businessObject);
  const stationDetails = foldStationDetails(input.stationDetails);
  const servicetimes = foldServiceTimes(input.servicetimes ?? {});

  const lineByCode = new Map<
    string,
    { code: string; name: string; en?: string; color: string; cards: GzLineCard[] }
  >();
  for (const card of cards) {
    const code = card.lineShowCode.trim();
    const existing = lineByCode.get(code);
    if (existing) {
      existing.cards.push(card);
    } else {
      lineByCode.set(code, {
        code,
        name: card.lineName.trim(),
        en: card.lineNameEn?.trim(),
        color: hexToCss(card.lineColor) ?? '',
        cards: [card]
      });
    }
  }

  // lineCn (e.g. "一号线", "三北线") -> line_id, so branch cards resolve too.
  const lineCnToId = new Map<string, string>();
  const lineNameToId = new Map<string, string>();
  for (const [_code, info] of lineByCode) {
    const lineId = `${NETWORK_ID}-line-${lineSlug(info.code, info.en)}`;
    lineCnToId.set(info.name, lineId);
    for (const c of info.cards) lineNameToId.set(c.lineName.trim(), lineId);
  }

  // Detect loop lines from service time data. A line is a loop only when its
  // own records carry 内环/外环 directions — a station shared with the loop
  // line (e.g. 天河公园 on Line 11) must not taint every other line serving it.
  const loopLines = new Set<string>();
  for (const recs of Object.values(servicetimes)) {
    for (const r of recs) {
      if (detectLoopDirection(r.remark, r.toStationName) === undefined) continue;
      const lineId = lineCnToId.get(r.lineCn) ?? lineNameToId.get(r.lineCn);
      if (lineId) loopLines.add(lineId);
    }
  }

  const stationNames = new Set<string>();
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segmentByPair = new Map<string, SegmentEncoded>();
  const stopsByLine = new Map<string, StopEncoded[]>();

  const lineRecords: LineEncoded[] = [];
  for (const [code, info] of lineByCode) {
    const lineId = `${NETWORK_ID}-line-${lineSlug(info.code, info.en)}`;
    const primary = primaryCard(info.cards);
    const aliases = info.cards.map((c) => c.lineName.trim()).filter((n) => n !== primary.lineName);
    lineRecords.push({
      id: lineId,
      name: primary.lineName,
      names: {
        zh: primary.lineName,
        en: primary.lineNameEn?.trim() || info.en || primary.lineName
      },
      aliases: [...new Set(aliases)],
      mode: (() => {
        const zh = primary.lineName;
        const en = (primary.lineNameEn ?? info.en ?? '').toLowerCase();
        if (code.startsWith('TH') || code.startsWith('TNH') || zh.includes('有轨'))
          return 'tram' as const;
        if (zh.includes('城际') || en.includes('intercity')) return 'suburban_rail' as const;
        if (zh.includes('APM')) return 'other' as const;
        if (/^[A-Z]{1,2}$/.test(code) && !/^[0-9]+$/.test(code) && !code.startsWith('F'))
          return 'suburban_rail' as const;
        return 'metro' as const;
      })(),
      status: 'operating',
      loop: loopLines.has(lineId),
      source_ids: [{ source: 'gzmtr-linestation', id: code }],
      color: info.color || undefined,
      // `lineShowCode` is the operator's own compact display code (`APM`,
      // `F2`, `广惠`) — an exact match for short_name, no derivation needed.
      // The resolver only guards against an empty source value.
      short_name: resolveLineShortName(primary.lineName, code),
      extras: {
        lineShowCode: code,
        cards: info.cards.map((c) => c.lineName.trim()),
        names_source: 'source'
      }
    });

    // Primary first so trunk stops keep a stable order; branches follow.
    const orderedCards = [primary, ...info.cards.filter((c) => c !== primary)];
    const unique: GzStation[] = [];
    const seen = new Set<string>();
    for (const card of orderedCards) {
      for (const s of card.stations) {
        if (seen.has(s.stationName)) continue;
        seen.add(s.stationName);
        unique.push(s);
      }
    }

    const stopIdByStation = new Map<string, string>();
    const lineStops: StopEncoded[] = [];
    unique.forEach((s, idx) => {
      stationNames.add(s.stationName);
      const stationId = `${NETWORK_ID}-${stationIdFor(s.stationNameEn, s.stationName)}`;
      const stopId = `${stationId}-${slug(lineId)}`;
      stopIdByStation.set(s.stationName, stopId);
      const stop: StopEncoded = {
        id: stopId,
        station_id: stationId,
        line_id: lineId,
        sequence: idx,
        is_terminal: idx === 0 || idx === unique.length - 1,
        source_id: s.stationShowCode
      };
      stops.push(stop);
      lineStops.push(stop);
    });
    stopsByLine.set(lineId, lineStops);

    // One pattern per source line card (branch cards included).
    const cardPatterns: { card: GzLineCard; pattern: PatternEncoded }[] = [];
    for (const card of info.cards) {
      const stopIds = card.stations
        .map((s) => stopIdByStation.get(s.stationName))
        .filter((id): id is string => id !== undefined);
      if (stopIds.length < 2) continue;
      const pattern: PatternEncoded = {
        id: `${lineId}-pattern-${readableSlug(card.orderNum) || card.orderNum}`,
        line_id: lineId,
        name: card.lineName.trim(),
        names: {
          zh: card.lineName.trim(),
          en: card.lineNameEn?.trim() || card.lineName.trim()
        },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0],
        terminal_stop_id: stopIds[stopIds.length - 1],
        is_primary: card === primary,
        source_ids: [{ source: 'gzmtr-linestation', id: card.orderNum }],
        extras: { lineShowCode: code, orderNum: card.orderNum }
      };
      cardPatterns.push({ card, pattern });
    }

    // Junction = a stop shared with the primary pattern, preferring the
    // branch's own first stop.
    const primaryPattern = cardPatterns.find((p) => p.card === primary)?.pattern;
    const primaryStopSet = new Set(primaryPattern?.stop_ids ?? []);
    for (let k = 0; k < cardPatterns.length; k++) {
      const { card, pattern } = cardPatterns[k];
      if (pattern.is_primary || !primaryPattern) continue;
      const shared = pattern.stop_ids.filter((id) => primaryStopSet.has(id));
      if (shared.length > 0) {
        cardPatterns[k] = { card, pattern: { ...pattern, junction_stop_id: shared[0] } };
      }
    }

    for (const { pattern } of cardPatterns) {
      patterns.push(pattern);
      const patternStops = pattern.stop_ids;
      for (let i = 0; i < patternStops.length - 1; i++) {
        const aId = patternStops[i];
        const bId = patternStops[i + 1];
        const aStop = lineStops.find((s) => s.id === aId);
        const bStop = lineStops.find((s) => s.id === bId);
        if (!aStop || !bStop) continue;
        const key = `${aId}|${bId}`;
        if (segmentByPair.has(key)) continue;
        segmentByPair.set(key, {
          id: `${NETWORK_ID}-seg-${aId}-${bId}`,
          line_id: lineId,
          from_stop_id: aId,
          to_stop_id: bId,
          from_station_id: aStop.station_id,
          to_station_id: bStop.station_id,
          direction: 'both',
          travel_time_seconds: DEFAULT_SEGMENT_SECONDS,
          travel_time_source: 'estimated' as const,
          source_id: aStop.source_id
        });
      }
    }
  }

  // English names keyed by Chinese name.
  const enByZh = new Map<string, string>();
  for (const card of cards) {
    for (const s of card.stations) {
      if (s.stationNameEn) enByZh.set(s.stationName, s.stationNameEn);
    }
  }

  const patternsByLine = new Map<string, PatternEncoded[]>();
  for (const p of patterns) {
    const arr = patternsByLine.get(p.line_id) ?? [];
    arr.push(p);
    patternsByLine.set(p.line_id, arr);
  }

  // Build timetables from service times. Direction is the destination terminal.
  const timetables: TimetableEncoded[] = [];
  const usedTtIds = new Set<string>();
  for (const [name, recs] of Object.entries(servicetimes)) {
    const stationId = `${NETWORK_ID}-${stationIdFor(enByZh.get(name), name)}`;
    for (const r of recs) {
      const lineId = lineCnToId.get(r.lineCn) ?? lineNameToId.get(r.lineCn);
      if (!lineId) continue;
      const lineStops = stopsByLine.get(lineId) ?? [];
      const stop = lineStops.find((s) => s.station_id === stationId);
      if (!stop) continue;

      const toName = stripDirectionAnnotation(r.toStationName);
      const destStop = lineStops.find(
        (s) => s.station_id === `${NETWORK_ID}-${stationIdFor(enByZh.get(toName), toName)}`
      );
      if (!destStop) continue;

      const linePatterns = patternsByLine.get(lineId) ?? [];
      const pattern =
        linePatterns.find(
          (p) =>
            p.stop_ids.includes(stop.id) &&
            p.stop_ids.includes(destStop.id) &&
            (p.terminal_stop_id === destStop.id || p.origin_stop_id === destStop.id)
        ) ??
        linePatterns.find(
          (p) => p.stop_ids.includes(stop.id) && p.stop_ids.includes(destStop.id)
        ) ??
        linePatterns.find((p) => p.stop_ids.includes(stop.id));
      if (!pattern) continue;

      const loopDir = detectLoopDirection(r.remark, r.toStationName);
      const isLoop = loopLines.has(lineId);
      timetables.push({
        id: ensureUniqueTtId(
          usedTtIds,
          NETWORK_ID,
          stationId,
          lineId,
          isLoop ? (loopDir ?? 'loop') : destStop.station_id
        ),
        station_id: stationId,
        stop_id: stop.id,
        line_id: lineId,
        station_code: stop.source_id,
        source_id: stop.source_id,
        destination_stop_id: isLoop ? undefined : destStop.id,
        pattern_id: pattern.id,
        direction_type: loopDir ?? (isLoop ? 'linear' : undefined),
        direction_label: r.toStationName,
        first_train: [r.startTime],
        last_train: [r.endTime],
        service: 'all_days'
      });
    }
  }

  // Derive segment times from last-train chains, per pattern.
  const derived = deriveSegmentTimes(patterns, stops, timetables, {});
  const finalSegments = applyDerivedTimes([...segmentByPair.values()], derived);

  const finalTimetables = timetables.map(normalizeTimetableTimes).filter(hasValidTimes);

  // Official getByNameOrCode coords are raw candidates — same-name POIs from
  // other cities are rejected later in fillCoordinates (bbox + line peers).
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  for (const [name, detail] of Object.entries(stationDetails)) {
    if (detail?.longitude != null && detail?.latitude != null) {
      officialLocations.set(fold(name), {
        lon: detail.longitude,
        lat: detail.latitude,
        crs: 'gcj02'
      });
    }
  }

  const stations: StationEncoded[] = applyTimetableServiceStatus(
    [...stationNames].map((name) => {
      const detail = stationDetails[name];
      const en = enByZh.get(name) ?? detail?.nameEN ?? undefined;
      const id = `${NETWORK_ID}-${stationIdFor(en, name)}`;
      const names = { zh: name, en: en ?? name };
      return {
        id,
        name,
        names,
        status: 'operating' as const,
        source_ids: detail?.stationRelateId
          ? [{ source: 'gzmtr-station', id: detail.stationRelateId }]
          : []
      };
    }),
    stops,
    finalTimetables,
    []
  );

  return {
    network: {
      id: NETWORK_ID,
      name: '广州地铁',
      names: { zh: '广州地铁', en: 'Guangzhou Metro' },
      city: {
        id: 'CN-4401',
        name: { zh: '广州', en: 'Guangzhou' },
        country: 'CN',
        population: 18676605,
        area: 7248.86,
        location: { type: 'Point', coordinates: [113.26, 23.13] }
      },
      country_code: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      coordinate_system: 'gcj02',
      default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
      routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 }
    },
    lines: lineRecords,
    stations,
    stops,
    patterns,
    segments: finalSegments,
    transfers: deriveTransfers(stations, stops),
    timetables: finalTimetables,
    officialLocations
  };
}
