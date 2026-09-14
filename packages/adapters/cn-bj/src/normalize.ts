import type {
  LineEncoded,
  NetworkEncoded,
  OfficialTransfer,
  PatternEncoded,
  SegmentEncoded,
  StationEncoded,
  StopEncoded,
  TimetableEncoded,
  TransferEncoded
} from '@openmetro/core';
import {
  applyTimetableServiceStatus,
  deriveLineEnglishName,
  deriveLineShortName,
  deriveTransfers,
  fillMissingSegmentTimes,
  hasValidTimes,
  lineSlug,
  normalizeTimetableTimes,
  resolveLineShortName
} from '@openmetro/core';
import { XMLParser } from 'fast-xml-parser';
import { buildBeijingTimetablesFromTimeinfos } from './timeinfos.js';

export interface BeijingRawInput {
  beijingXml: string;
  apiStationsJson: unknown[];
  /** stations.xml raw text (for first/last train `firstend`). */
  stationsXml?: string;
  /** Official /api/guanwang/v2/getTimeinfos payload (authoritative). */
  timeinfos?: unknown;
  /** Official interchange.xml raw text (per-line-pair transfer walk times). */
  interchangeXml?: string;
}

export interface BeijingCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Line codes the source XML mislabels as loops. Beijing Line 11 (`lcode=11`)
 * is a linear line; the XML's `loop="true"` is a source error.
 */
const FORCE_NON_LOOP_LINES = new Set(['11']);

/**
 * Curated `short_name` values for lines whose compact display code cannot or
 * must not be derived from the name, keyed by source `lcode`.
 *
 * The source's own `slb` short label is authoritative and used by default;
 * this table only pins the rare cases where `slb` is wrong or absent. An entry
 * bypasses the `lnub` cross-check below, so any new divergence needs an entry
 * here (or a fix at the source).
 */
const SHORT_NAME_OVERRIDES: Partial<Record<string, string>> = {
  '73': '18'
};

/**
 * Official short label from the source's `slb` attribute.
 *
 * `slb` is a comma-separated list of per-segment labels (`1,1,八通` for
 * `1号线八通线`); the first token is the line's badge (`1`). Returns
 * `undefined` when the source publishes none.
 */
function officialShortLabel(slb: string | undefined): string | undefined {
  const first = slb?.split(',')[0]?.trim();
  return first || undefined;
}

interface ApiStation {
  id: number;
  c_name: string;
  e_name: string;
  e_name2: string;
  ox: number;
  oy: number;
}

interface RawLine {
  '@_lid': string;
  '@_lb': string;
  '@_i': string;
  '@_loop': string;
  '@_lc': string;
  '@_lnub': string;
  '@_lcode': string;
  '@_slb'?: string;
  p?: RawPoint | RawPoint[];
}

interface RawPoint {
  '@_n': string;
  '@_acc': string;
  '@_lb': string;
  '@_x': string;
  '@_y': string;
  '@_st': string;
  '@_ex': string;
  '@_ut'?: string;
  '@_dt'?: string;
  '@_ud'?: string;
  '@_dd'?: string;
}

const NETWORK_ID = 'cn-bj';

/** Classify Beijing lines that are not conventional metro. */
function lineMode(lcode: string, zhName: string): LineEncoded['mode'] {
  if (zhName.includes('T1') || zhName.includes('有轨')) return 'tram';
  if (zhName.includes('西郊')) return 'light_rail';
  if (zhName.includes('机场')) return 'airport_express';
  if (lcode === '79') return 'tram'; // 亦庄T1线
  if (lcode === '89') return 'light_rail'; // 西郊线
  if (lcode === '91') return 'light_rail'; // S1线 (中低速磁浮)
  if (lcode === '98' || lcode === '88') return 'airport_express';
  return 'metro';
}

/** Human-readable station slug keyed off the English (or pinyin) name. */
function stationSlug(en: string): string {
  return en
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Fallback ASCII slug for names with no English value. */
function asciiSlug(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!out) {
    out = [...Buffer.from(s, 'utf-8')].map((b) => b.toString(16)).join('');
  }
  return out;
}

export function normalize(input: BeijingRawInput): BeijingCanonical {
  const doc = parser.parse(input.beijingXml) as { sw: { l: RawLine[] } };
  const lines = Array.isArray(doc.sw.l) ? doc.sw.l : [doc.sw.l];

  const enByZh = new Map<string, string>();
  for (const s of input.apiStationsJson as ApiStation[]) {
    const en = cleanEn(s.e_name);
    if (en) enByZh.set(s.c_name, en);
  }

  const lineRecords: LineEncoded[] = [];
  const stationNames = new Set<string>();
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];

  for (const rl of lines) {
    const lid = rl['@_lid'];
    const lb = rl['@_lb'];
    const lineEn = deriveLineEnglishName(lb, rl['@_lcode']) ?? lb;
    const lineId = `${NETWORK_ID}-line-${lineSlug(rl['@_lcode'], lineEn)}`;
    const color = hexToCss(rl['@_lc']);
    const isLoop = rl['@_loop'] === 'true' && !FORCE_NON_LOOP_LINES.has(rl['@_lcode']);

    // `lnub` is an internal source id that happens to equal the badge number on
    // purely numbered lines — cross-check them and fail loudly on divergence.
    // The source's `slb` short label is authoritative; specials come from the
    // curated override table above.
    const lnub = rl['@_lnub'];
    const override = SHORT_NAME_OVERRIDES[rl['@_lcode']];
    const derived = deriveLineShortName(lb);
    if (
      override === undefined &&
      derived != null &&
      /^\d+$/.test(derived) &&
      lnub &&
      derived !== lnub
    ) {
      throw new Error(`cn-bj line ${lid} (${lb}): derived short_name ${derived} != lnub ${lnub}`);
    }
    const shortName = override ?? resolveLineShortName(lb, officialShortLabel(rl['@_slb']));

    lineRecords.push({
      id: lineId,
      name: lb,
      names: { zh: lb, en: lineEn },
      aliases: [],
      mode: lineMode(rl['@_lcode'], lb),
      status: 'operating',
      loop: isLoop,
      source_ids: [{ source: 'bjsubway-beijing-xml', id: lid }],
      color: color ?? undefined,
      short_name: shortName,
      extras: {
        lcode: rl['@_lcode'],
        lnub: rl['@_lnub'],
        slb: rl['@_slb'],
        names_source: 'derived'
      }
    });

    const points = rl.p ? (Array.isArray(rl.p) ? rl.p : [rl.p]) : [];
    const orderedStops = points.filter((p) => p['@_st'] === 'true');
    const lineStops: StopEncoded[] = [];

    // Beijing's source is a single ordered alignment per line (loops included),
    // so each line gets one primary pattern.
    const patternId = `${lineId}-pattern-main`;
    for (const p of orderedStops) {
      const acc = p['@_acc'];
      const name = p['@_lb'];
      const x = Number(p['@_x']);
      const y = Number(p['@_y']);
      stationNames.add(name);

      const stationId = `${NETWORK_ID}-${stationIdFor(name, enByZh.get(name))}`;
      const stopId = `${stationId}-${slugTo(lineId)}`;
      lineStops.push({
        id: stopId,
        station_id: stationId,
        line_id: lineId,
        sequence: orderedStops.indexOf(p),
        is_terminal: p['@_ex'] === 'true' || p['@_n'] === '0',
        source_id: acc,
        schematic: { x, y, crs: 'schematic' }
      });
    }
    stops.push(...lineStops);

    if (lineStops.length >= 2) {
      const stopIds = lineStops.map((s) => s.id);
      patterns.push({
        id: patternId,
        line_id: lineId,
        name: lb,
        names: { zh: lb, en: lineEn },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0],
        terminal_stop_id: stopIds[stopIds.length - 1],
        is_primary: true,
        source_ids: [{ source: 'bjsubway-beijing-xml', id: lid }],
        extras: { loop: isLoop }
      });
    }

    for (let i = 0; i < orderedStops.length - 1; i++) {
      const a = orderedStops[i];
      const b = orderedStops[i + 1];
      const aId = `${NETWORK_ID}-${stationIdFor(a['@_lb'], enByZh.get(a['@_lb']))}`;
      const bId = `${NETWORK_ID}-${stationIdFor(b['@_lb'], enByZh.get(b['@_lb']))}`;
      const aStop = `${aId}-${slugTo(lineId)}`;
      const bStop = `${bId}-${slugTo(lineId)}`;
      segments.push({
        id: `${NETWORK_ID}-seg-${aStop}-${bStop}`,
        line_id: lineId,
        from_stop_id: aStop,
        to_stop_id: bStop,
        from_station_id: aId,
        to_station_id: bId,
        direction: 'both',
        travel_time_seconds: numOrUndef(a['@_ut']),
        travel_time_source: 'source' as const,
        distance_km: numOrUndef(a['@_ud']),
        source_id: a['@_acc']
      });
    }
  }

  const timetables: TimetableEncoded[] = buildTimetables(input, lineRecords, stops, enByZh);

  const stations: StationEncoded[] = applyTimetableServiceStatus(
    [...stationNames].map((name) => {
      const en = enByZh.get(name);
      const id = `${NETWORK_ID}-${stationIdFor(name, en)}`;
      const names = { zh: name, en: en ?? name };
      return {
        id,
        name,
        names,
        status: 'operating' as const,
        source_ids: []
      };
    }),
    stops,
    timetables,
    ['老观里']
  );

  const official = input.interchangeXml
    ? parseBeijingInterchange(input.interchangeXml, lineRecords, stops, enByZh)
    : [];

  // The source publishes `0` for a few unmeasured segments; derive or estimate
  // them so the routing graph is never disconnected.
  const finalSegments = fillMissingSegmentTimes(segments, patterns, stops, timetables);

  return {
    network: {
      id: NETWORK_ID,
      name: '北京地铁',
      names: { zh: '北京地铁', en: 'Beijing Subway' },
      city: {
        id: 'CN-11',
        name: { zh: '北京', en: 'Beijing' },
        country: 'CN',
        population: 21893095,
        area: 16410.54,
        location: { type: 'Point', coordinates: [116.407526, 39.90403] }
      },
      country_code: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      coordinate_system: 'gcj02',
      default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
      routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
      operators: [],
      source: []
    },
    lines: lineRecords,
    stations,
    stops,
    patterns,
    segments: finalSegments,
    transfers: deriveTransfers(stations, stops, official),
    timetables: timetables.map(normalizeTimetableTimes).filter(hasValidTimes)
  };
}

/**
 * Legacy line-number legend embedded in `interchange.xml`. The source file
 * codes lines with an internal numbering (see the comment at the bottom of the
 * XML); newer lines are absent and fall back to the default transfer penalty.
 */
const INTERCHANGE_LEGEND: Record<string, string> = {
  '0': '1号线',
  '1': '2号线',
  '2': '4号线',
  '3': '5号线',
  '4': '6号线',
  '5': '8号线',
  '6': '9号线',
  '7': '10号线',
  '8': '13号线',
  '9': '14号线',
  '10': '15号线',
  '11': '八通线',
  '12': '昌平线',
  '13': '亦庄线',
  '14': '房山线',
  '15': '机场线',
  '16': '7号线',
  '17': '14号线'
};

function matchLineId(name: string, lineRecords: LineEncoded[]): string | undefined {
  const direct = lineRecords.find((l) => l.name === name);
  if (direct) return direct.id;
  const prefix = lineRecords.find((l) => l.name.startsWith(name));
  if (prefix) return prefix.id;
  if (name === '八通线') return lineRecords.find((l) => l.name.includes('八通'))?.id;
  if (name === '机场线') return lineRecords.find((l) => l.name.includes('机场'))?.id;
  return undefined;
}

/**
 * Parse `interchange.xml` (`<ex fl tl s t/>`) into official directional
 * transfer times. Entries are only kept when both lines resolve to the current
 * topology and actually call at the named station, so a stale legend entry can
 * never attach a walk time to the wrong line.
 */
export function parseBeijingInterchange(
  xml: string,
  lineRecords: LineEncoded[],
  stops: StopEncoded[],
  enByZh: Map<string, string>
): OfficialTransfer[] {
  const doc = parser.parse(xml) as {
    exs: { ex?: Record<string, string> | Record<string, string>[] };
  };
  const raw = doc.exs?.ex;
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const linesAtStation = new Map<string, Set<string>>();
  for (const stop of stops) {
    const set = linesAtStation.get(stop.station_id) ?? new Set<string>();
    set.add(stop.line_id);
    linesAtStation.set(stop.station_id, set);
  }
  const lineIdByLegendName = new Map<string, string | undefined>();
  for (const [code, name] of Object.entries(INTERCHANGE_LEGEND)) {
    lineIdByLegendName.set(code, matchLineId(name, lineRecords));
  }

  const out: OfficialTransfer[] = [];
  for (const ex of list) {
    const fl = ex['@_fl'];
    const tl = ex['@_tl'];
    const name = ex['@_s'];
    const t = Number(ex['@_t']);
    if (!fl || !tl || !name || !Number.isFinite(t)) continue;
    const fromLine = lineIdByLegendName.get(fl);
    const toLine = lineIdByLegendName.get(tl);
    if (!fromLine || !toLine || fromLine === toLine) continue;
    const stationId = `${NETWORK_ID}-${stationIdFor(name, enByZh.get(name))}`;
    const atStation = linesAtStation.get(stationId);
    if (!atStation?.has(fromLine) || !atStation.has(toLine)) continue;
    out.push({
      station_id: stationId,
      from_line_id: fromLine,
      to_line_id: toLine,
      walk_time_seconds: t,
      source_id: 'bjsubway-interchange-xml'
    });
  }
  return out;
}

function stationIdFor(zh: string, en?: string): string {
  return en ? stationSlug(en) : asciiSlug(zh);
}

function slugTo(lineId: string): string {
  return lineId.replace(`${NETWORK_ID}-line-`, '');
}

function cleanEn(raw: string): string {
  // Strip newlines and parenthetical direction/detail markers for slugs.
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function numOrUndef(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^0x/, '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return undefined;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Stable short hash of a string (for unique, ASCII-safe IDs). */
function hashSlug(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

interface RawStation {
  '@_name': string;
  '@_firstend'?: string;
  '@_linename'?: string;
}

/**
 * Parse Beijing stations.xml `firstend` attributes into timetable records.
 *
 * firstend format per station (direction blocks separated by "||||||"):
 *   LINE::::::ORIGIN—TERMINAL::::::首车  HH:MM、末车  HH:MM、末车半程(TERM)  HH:MM
 * We parse each block, map the LINE name to a line_id, and record first/last
 * train times. Beijing's per-segment times come from beijing.xml (kept as
 * "source"). Direction is inferred from origin/terminal vs the line's stop order.
 */
function buildBeijingTimetables(
  stationsXml: string,
  lineRecords: LineEncoded[],
  stops: StopEncoded[],
  enByZh: Map<string, string>
): TimetableEncoded[] {
  const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = xmlParser.parse(stationsXml) as { stations: { s: RawStation[] } };
  const sList = Array.isArray(doc.stations.s) ? doc.stations.s : [doc.stations.s];
  const lineIdByName = new Map<string, string>();
  for (const l of lineRecords) lineIdByName.set(l.name, l.id);
  const stopsByLine = new Map<string, StopEncoded[]>();
  for (const st of stops) {
    const arr = stopsByLine.get(st.line_id) ?? [];
    arr.push(st);
    stopsByLine.set(st.line_id, arr);
  }
  for (const arr of stopsByLine.values()) arr.sort((a, b) => a.sequence - b.sequence);

  const out: TimetableEncoded[] = [];
  for (const s of sList) {
    const name = s['@_name'];
    const stationId = `${NETWORK_ID}-${stationIdFor(name, enByZh.get(name))}`;
    const fe = s['@_firstend'] ?? '';
    const blocks = fe.split('||||||').filter(Boolean);
    for (const block of blocks) {
      const parts = block.split('::::::');
      if (parts.length < 3) continue;
      const lineName = parts[0].trim();
      const route = parts[1].trim();
      const times = parts[2];
      const lineId = lineIdByName.get(lineName);
      if (!lineId) continue;
      const seg = route.split(/—|-/).map((x) => x.trim());
      const originName = seg[0];
      const terminal = seg[1];
      const first = /首车\s*([\d:]+|——)/.exec(times)?.[1];
      const last = /末车\s*([\d:]+|——)/.exec(times)?.[1];
      const stop = stopsByLine.get(lineId)?.find((x) => x.station_id === stationId);
      const lineStops = stopsByLine.get(lineId) ?? [];
      const termStop = terminal
        ? lineStops.find(
            (x) => x.station_id === `${NETWORK_ID}-${stationIdFor(terminal, enByZh.get(terminal))}`
          )
        : undefined;
      const originStop = originName
        ? lineStops.find(
            (x) =>
              x.station_id === `${NETWORK_ID}-${stationIdFor(originName, enByZh.get(originName))}`
          )
        : undefined;
      if (!stop) continue;
      const patternId = `${lineId}-pattern-main`;
      if (!first || first === '——' || !last || last === '——') continue;
      out.push({
        id: `${NETWORK_ID}-${stationId}-${slugTo(lineId)}-to-${asciiSlug(terminal ?? '')}-${hashSlug(route)}`,
        station_id: stationId,
        stop_id: stop.id,
        line_id: lineId,
        station_code: stop.source_id,
        source_id: stop.source_id,
        destination_stop_id: termStop?.id ?? lineStops[lineStops.length - 1]?.id,
        origin_stop_id: originStop?.id,
        pattern_id: patternId,
        direction_label: route,
        first_train: [first],
        last_train: [last],
        service: 'all_days'
      });
    }
  }
  return out;
}
/**
 * Build canonical timetable records. Prefers the official
 * /api/guanwang/v2/getTimeinfos payload (covers every line); falls back to
 * parsing stations.xml firstend.
 */
function buildTimetables(
  input: BeijingRawInput,
  lineRecords: LineEncoded[],
  stops: StopEncoded[],
  enByZh: Map<string, string>
): TimetableEncoded[] {
  if (input.timeinfos) {
    const stopsByLine = new Map<string, StopEncoded[]>();
    for (const st of stops) {
      const arr = stopsByLine.get(st.line_id) ?? [];
      if (!arr.some((x) => x.id === st.id)) arr.push(st);
      stopsByLine.set(st.line_id, arr);
    }
    for (const arr of stopsByLine.values()) arr.sort((a, b) => a.sequence - b.sequence);

    const lineIdByCode = new Map<string, string>();
    for (const l of lineRecords) {
      const lcode = (l.extras as { lcode?: string } | undefined)?.lcode;
      if (lcode) lineIdByCode.set(lcode, l.id);
    }

    // Collect loop line IDs from line records.
    const loopLineIds = new Set<string>();
    for (const l of lineRecords) {
      if (l.loop) loopLineIds.add(l.id);
    }

    const stationIdByName = (name: string) =>
      `${NETWORK_ID}-${stationIdFor(name, enByZh.get(name))}`;
    const stationIdByCleanedName = stationIdByName;

    return buildBeijingTimetablesFromTimeinfos({
      timeinfos: input.timeinfos as never,
      lineIdByCode,
      stationIdByName,
      stationIdByCleanedName,
      stopsByLine,
      loopLineIds,
      networkId: NETWORK_ID
    });
  }

  return input.stationsXml
    ? buildBeijingTimetables(input.stationsXml, lineRecords, stops, enByZh)
    : [];
}
