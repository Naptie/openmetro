import {
  coerceStationStatus,
  deriveLineEnglishName,
  hasValidTimes,
  type LineEncoded,
  type LineStatus,
  type NetworkEncoded,
  type PatternEncoded,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';

export interface SuzhouRawInput {
  szmtrJs: string;
  stationInfoZhJs: string;
  stationInfoEnJs: string;
  szmtrTimeJs: string;
  virtualLines?: unknown;
}

export interface SuzhouCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /** Official 4-digit codes keyed by station id (for fare origin queries). */
  fareCodesByStationId: Map<string, string>;
}

/**
 * Map compound official labels used on the schematic (e.g. `苏州园区/火车站`)
 * onto a single geocodable station name. City-specific; core stays generic.
 */
const NAME_GEOCODE_OVERRIDES: Record<string, string> = {
  '陆慕/古巷': '陆慕',
  '苏州园区/火车站': '苏州园区火车站'
};

function geocodeName(zh: string): string {
  return NAME_GEOCODE_OVERRIDES[zh] ?? (zh.split('/')[0].trim() || zh);
}

const NETWORK_ID = 'cn-suzhou';

/** Operating metro line numbers on the official map (tram/T1 excluded). */
const OPERATING_LINE_NOS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '11']);

/** Map line array index → line metadata from `szmtr.line[i]`. */
interface RawLineMeta {
  index: number;
  sourceId: string;
  nameZh: string;
  nameEn: string;
  color?: string;
  status: LineStatus;
}

interface RawNode {
  id: string;
  type: string;
}

interface RawStationName {
  zh: string;
  en: string;
  pinyin: string;
}

function parseLineMetas(szmtrJs: string): RawLineMeta[] {
  const out: RawLineMeta[] = [];
  const re = /szmtr\.line\[(\d+)\]\s*=\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(szmtrJs)) !== null) {
    const index = Number(m[1]);
    const body = m[2];
    const num = (key: string): string | undefined => {
      const quoted = new RegExp(`${key}:\\s*"([^"]*)"`).exec(body);
      if (quoted) return quoted[1];
      const bare = new RegExp(`${key}:\\s*([^,}\\s]+)`).exec(body);
      return bare?.[1];
    };
    const sourceId = num('id') ?? '';
    const nameZh = num('name') ?? '';
    const nameEn = num('eName') ?? '';
    const colorRaw = num('color');
    if (!nameZh) continue;
    // Extension placeholders / planned corridors: "N延线".
    const isExtension = nameZh.includes('延线');
    const lineNo = sourceId || (isExtension ? '' : (/\d+/.exec(nameZh)?.[0] ?? ''));
    const status: LineStatus =
      isExtension || !OPERATING_LINE_NOS.has(lineNo) ? 'under_construction' : 'operating';
    out.push({
      index,
      sourceId: sourceId || lineNo || `idx-${index}`,
      nameZh,
      nameEn,
      color: colorRaw && colorRaw !== '#FFFFFF' && colorRaw !== '#EAEAEA' ? colorRaw : undefined,
      status
    });
  }
  return out;
}

interface RawNode {
  id: string;
  type: string;
  /** Official schematic map coordinates from `szmtr.js`. */
  x?: number;
  y?: number;
}

function parseNodeLists(szmtrJs: string): Map<number, RawNode[]> {
  const map = new Map<number, RawNode[]>();
  const re = /szmtr\.line\[(\d+)\]\.station\s*=\s*new Array\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(szmtrJs)) !== null) {
    const index = Number(m[1]);
    const nodes: RawNode[] = [];
    for (const obj of m[2].matchAll(/\{([^}]+)\}/g)) {
      const body = obj[1];
      const id = /id:\s*"([^"]+)"/.exec(body)?.[1];
      if (!id) continue;
      const type = /type:\s*"([^"]+)"/.exec(body)?.[1] ?? 'normal';
      const x = Number(/(?:^|[,{\s])x:\s*([\d.]+)/.exec(body)?.[1]);
      const y = Number(/(?:^|[,{\s])y:\s*([\d.]+)/.exec(body)?.[1]);
      nodes.push({
        id,
        type,
        x: Number.isFinite(x) ? x : undefined,
        y: Number.isFinite(y) ? y : undefined
      });
    }
    map.set(index, nodes);
  }
  return map;
}

function parseStationNames(js: string): Map<string, RawStationName> {
  const out = new Map<string, RawStationName>();
  const re = /szmtr\.stations\["([^"]+)"\]\s*=\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    const id = m[1];
    const body = m[2];
    const name = /name:\s*"([^"]*)"/.exec(body)?.[1] ?? '';
    const pinyin = /pinyin:\s*"([^"]*)"/.exec(body)?.[1] ?? '';
    const existing = out.get(id);
    out.set(id, {
      zh: existing?.zh || name,
      en: existing?.en || '',
      pinyin: existing?.pinyin || pinyin
    });
  }
  return out;
}

function mergeEnNames(zhMap: Map<string, RawStationName>, enJs: string): void {
  const re = /szmtr\.stations\["([^"]+)"\]\s*=\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(enJs)) !== null) {
    const id = m[1];
    const name = /name:\s*"([^"]*)"/.exec(m[2])?.[1] ?? '';
    const cur = zhMap.get(id);
    if (cur) cur.en = name;
    else zhMap.set(id, { zh: '', en: name, pinyin: '' });
  }
}

/** Map node id → per-line first/last train blocks. */
interface TimeBlock {
  lineID: string;
  down_begintime?: string;
  down_endtime?: string;
  up_begintime?: string;
  up_endtime?: string;
  downDirectionID?: string;
  upDirectionID?: string;
}

function parseMetroTimes(js: string): Map<string, TimeBlock[]> {
  const out = new Map<string, TimeBlock[]>();
  const re = /metroTimeArray\['([^']+)'\]\s*=\s*new Array\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    const id = m[1];
    const rawBody = m[2] ?? '';
    const blocks: TimeBlock[] = [];
    const objRe = /\{[^{}]*"Time":\{[^{}]*\}[^{}]*\}/g;
    let o: RegExpExecArray | null;
    while ((o = objRe.exec(rawBody)) !== null) {
      try {
        const parsed = JSON.parse(o[0].replace(/(\w+):/g, '"$1":')) as {
          Time?: Record<string, string>;
          lineID?: string;
        };
        blocks.push({ lineID: parsed.lineID ?? '', ...(parsed.Time ?? {}) });
      } catch {
        // skip malformed fragment
      }
    }
    out.set(id, blocks);
    // Also accept simplified parse via regex fields if JSON-ish parse failed
    if (blocks.length === 0) {
      const lineID = /"lineID":"([^"]+)"/.exec(rawBody)?.[1] ?? '';
      const grab = (k: string) => new RegExp(`"${k}":"([^"]*)"`).exec(rawBody)?.[1];
      if (lineID) {
        blocks.push({
          lineID,
          down_begintime: grab('down_begintime'),
          down_endtime: grab('down_endtime'),
          up_begintime: grab('up_begintime'),
          up_endtime: grab('up_endtime'),
          downDirectionID: grab('downDirectionID'),
          upDirectionID: grab('upDirectionID')
        });
        out.set(id, blocks);
      }
    }
  }
  return out;
}

/** Official numeric station code embedded in a map node id. */
function baseCode(nodeId: string): string {
  const idx = nodeId.lastIndexOf('_');
  return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
}

function slug(s: string): string {
  return readableSlug(s) || asciiSlug(s);
}

function asciiSlug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (out) return out;
  return [...Buffer.from(s, 'utf-8')].map((b) => b.toString(16)).join('');
}

function stationIdFor(en: string | undefined, zh: string): string {
  return en ? slug(en) : asciiSlug(zh);
}

function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^#/, '');
  if (m.length !== 6) return undefined;
  return `#${m.toLowerCase()}`;
}

function firstTime(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split('#')
    .map((p) => p.trim())
    .filter((p) => p && p !== '--' && p !== '×');
  return parts.length ? parts : undefined;
}

/** Keep timetable arrays schema-legal (length 1 or 7); collapse extras to the first value. */
function alignTimes(
  first: string[] | undefined,
  last: string[] | undefined
): {
  first: string[];
  last: string[];
} {
  const f = (first ?? []).map(toHHMM);
  const l = (last ?? []).map(toHHMM);
  if (f.length === 0 && l.length === 0) return { first: [], last: [] };
  // Only publish a 7-day array when BOTH sides are full weekly vectors.
  if (f.length === 7 && l.length === 7) return { first: f, last: l };
  return { first: [f[0] ?? l[0]], last: [l[0] ?? f[0]] };
}

function toHHMM(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!m) return raw;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * Official English line label from the map JS + deterministic fallback.
 *
 * The map publishes `eName: "Line 1"`; a bare numeric `eName` or short_name
 * must not replace that display name. Wikidata may still refine later, but
 * only when `extras.names_source` is not already `source`.
 */
function officialLineEnglishName(nameZh: string, mapEName: string): string {
  // Official extension corridors: "6延线" → "Line 6 Extension".
  const ext = /^(\d+)\s*延线/.exec(nameZh);
  if (ext) return `Line ${ext[1]} Extension`;
  const map = mapEName.trim();
  // Prefer a real English phrase from the operator map ("Line 11").
  if (map && /[A-Za-z]{2,}/.test(map)) return map;
  const derived = deriveLineEnglishName(nameZh);
  if (derived) return derived;
  // A bare digit eName is a badge, not a display name.
  if (map && !/^\d+$/.test(map)) return map;
  return deriveLineEnglishName(map) ?? nameZh;
}

export function normalize(input: SuzhouRawInput): SuzhouCanonical {
  const lineMetas = parseLineMetas(input.szmtrJs);
  const nodesByLine = parseNodeLists(input.szmtrJs);
  const names = parseStationNames(input.stationInfoZhJs);
  mergeEnNames(names, input.stationInfoEnJs);
  const times = parseMetroTimes(input.szmtrTimeJs);

  /** Physical stations keyed by Chinese name (official interchange identity). */
  type Phys = {
    id: string;
    zh: string;
    en: string;
    pinyin: string;
    mapIds: Set<string>;
    codes: Set<string>;
    status: StationEncoded['status'];
    lineNos: Set<string>;
  };
  const physByName = new Map<string, Phys>();

  const lineRecords: LineEncoded[] = [];
  const lineIdByIndex = new Map<number, string>();
  /** Map node id → ordered list per source line index (named passenger nodes only). */
  const orderedStopMapIds = new Map<number, string[]>();
  /** Source line index → meta, for extension merge. */
  const metaByIndex = new Map<number, RawLineMeta>();
  /** Official short number ("6") → operating lineId, for 延线 merge. */
  const operatingLineIdByNo = new Map<string, string>();

  for (const meta of lineMetas) {
    const shortName = resolveLineShortName(meta.nameZh) ?? meta.sourceId;
    const lineId = `${NETWORK_ID}-line-${slug(shortName || meta.nameZh)}`;
    const nameEn = officialLineEnglishName(meta.nameZh, meta.nameEn);
    lineIdByIndex.set(meta.index, lineId);
    metaByIndex.set(meta.index, meta);
    if (meta.status === 'operating') {
      const no = /^\d+/.exec(shortName)?.[0];
      if (no) operatingLineIdByNo.set(no, lineId);
    }
    lineRecords.push({
      id: lineId,
      name: meta.nameZh,
      names: { zh: meta.nameZh, en: nameEn },
      aliases: [],
      mode: 'metro',
      status: meta.status,
      loop: false,
      color: hexToCss(meta.color),
      short_name: shortName,
      source_ids: [{ source: 'sz-mtr-map-js', id: meta.sourceId }],
      extras: {
        source_line_index: meta.index,
        names_source: 'source',
        parent_line_no: /^(\d+)\s*延线/.exec(meta.nameZh)?.[1],
        // 延线 corridors are patterns on the parent line, not stop owners.
        is_extension_corridor: /延线/.test(meta.nameZh)
      }
    });

    const nodes = nodesByLine.get(meta.index) ?? [];
    const ordered: string[] = [];
    for (const node of nodes) {
      // Geometry-only nodes on the schematic map.
      if (node.type === 'arc' || node.type === 'hide') continue;
      const nm = names.get(node.id);
      const zh = nm?.zh?.trim() ?? '';
      if (!zh) continue;
      const code = baseCode(node.id);
      const isOffline = node.type === 'offline';
      // Planned corridors keep under_construction; operating map nodes are operating.
      const stationStatus = coerceStationStatus(
        isOffline || meta.status !== 'operating' ? 'under_construction' : 'operating'
      );

      let phys = physByName.get(zh);
      if (!phys) {
        const canonicalZh = geocodeName(zh);
        phys = {
          id: `${NETWORK_ID}-${stationIdFor(nm?.en, canonicalZh)}`,
          zh: canonicalZh,
          en: (nm?.en?.trim() || canonicalZh).split('/')[0].trim() || canonicalZh,
          pinyin: nm?.pinyin ?? '',
          mapIds: new Set(),
          codes: new Set(),
          status: stationStatus,
          lineNos: new Set()
        };
        physByName.set(zh, phys);
      }
      phys.mapIds.add(node.id);
      if (/^\d+$/.test(code)) phys.codes.add(code);
      // Record the corridor the operator map drew this node on (6延线 vs 6号线).
      phys.lineNos.add(meta.nameZh);
      if (stationStatus === 'operating') phys.status = 'operating';
      ordered.push(node.id);
    }
    orderedStopMapIds.set(meta.index, ordered);
  }

  /**
   * Official map topology (`szmtr.js`) includes schematic x/y per node.
   *
   * Modeling:
   * - Operating lines own their official stop order as `pattern-main`.
   * - `N延线` is **not** a separate stop-owning line: it is an extension
   *   **pattern on line N**, starting/ending at the parent terminus that is
   *   geometrically nearest on the official schematic (7延线 ← 常楼, not 木里).
   *   The Line record for `N延线` remains in `lines.json` as UI metadata only.
   * - Independent planned corridors (e.g. 10号线) keep their own Line + stops.
   */
  const schematicByMapId = new Map<string, { x: number; y: number }>();
  for (const nodes of nodesByLine.values()) {
    for (const n of nodes) {
      if (n.x != null && n.y != null) schematicByMapId.set(n.id, { x: n.x, y: n.y });
    }
  }

  type EmitSeq = {
    lineId: string;
    meta: RawLineMeta;
    mapIds: string[];
  };
  const emitSeqs: EmitSeq[] = [];
  const extensionMetas: RawLineMeta[] = [];

  for (const meta of lineMetas) {
    const lineId = lineIdByIndex.get(meta.index);
    if (!lineId) continue;
    const isExtensionCorridor = /延线/.test(meta.nameZh);
    if (isExtensionCorridor) {
      extensionMetas.push(meta);
      continue;
    }
    const own = orderedStopMapIds.get(meta.index) ?? [];
    if (own.length < 2) continue;
    emitSeqs.push({ lineId, meta, mapIds: [...own] });
  }

  // Virtual through-service lines (official 3号线/11号线 registry).
  const virtualLineNames = new Map<string, string>();
  const vroot = input.virtualLines as { data?: { originalLineId?: string; lineName?: string }[] };
  for (const v of vroot?.data ?? []) {
    if (v.originalLineId && v.lineName) virtualLineNames.set(v.originalLineId, v.lineName);
  }

  const stations: StationEncoded[] = [];
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const transfers: TransferEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const fareCodesByStationId = new Map<string, string>();
  const ttIds = new Set<string>();

  // Destination map-id → station id for timetable destination_stop_id.
  const stationIdByMapId = new Map<string, string>();
  for (const phys of physByName.values()) {
    for (const mid of phys.mapIds) stationIdByMapId.set(mid, phys.id);
    const preferred = [...phys.codes].sort()[0] ?? '';
    if (preferred) fareCodesByStationId.set(phys.id, preferred);
  }

  /**
   * Emit stops/patterns/segments.
   *
   * Extension corridors (`N延线`) become non-primary patterns on line N whose
   * stop list reuses the parent terminus stop_id plus planned stations (same
   * physical connector stop — no duplicate stop identity, no fake transfer).
   */
  const stopIdByMapId = new Map<string, string>();
  const stopByLineMapId = new Map<string, string>(); // `${lineId}|${mapId}` → stopId
  const extLineExtrasByCorridor = new Map<string, Record<string, unknown>>();

  for (const seq of emitSeqs) {
    const { lineId, mapIds: ordered } = seq;
    if (ordered.length < 2) continue;
    const short = lineId.replace(`${NETWORK_ID}-line-`, '');
    const patternId = `${lineId}-pattern-main`;
    const patternStopIds: string[] = [];
    const patternStationIds: string[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const mapId = ordered[i];
      const phys = physByName.get(names.get(mapId)?.zh?.trim() ?? '');
      if (!phys) continue;
      const stopId = `${phys.id}-${short}`;
      stopIdByMapId.set(mapId, stopId);
      stopByLineMapId.set(`${lineId}|${mapId}`, stopId);
      patternStopIds.push(stopId);
      patternStationIds.push(phys.id);
      const code = baseCode(mapId);
      const sch = schematicByMapId.get(mapId);
      const isPlanned = phys.status === 'under_construction';
      stops.push({
        id: stopId,
        station_id: phys.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === ordered.length - 1,
        source_id: code,
        schematic: sch ? { x: sch.x, y: sch.y, crs: 'schematic' } : undefined,
        extras: isPlanned
          ? {
              planned_extension: true,
              map_corridor: [...phys.lineNos].find((n) => n.includes('延线'))
            }
          : undefined
      });
    }

    if (patternStopIds.length < 2) continue;

    patterns.push({
      id: patternId,
      line_id: lineId,
      name: seq.meta.nameZh,
      names: {
        zh: seq.meta.nameZh,
        en: officialLineEnglishName(seq.meta.nameZh, seq.meta.nameEn)
      },
      stop_ids: patternStopIds,
      origin_stop_id: patternStopIds[0],
      terminal_stop_id: patternStopIds[patternStopIds.length - 1],
      is_primary: true,
      source_ids: [{ source: 'sz-mtr-map-js', id: seq.meta.sourceId }],
      extras: {
        line_status: seq.meta.status,
        virtual_line_name: virtualLineNames.get(seq.meta.sourceId),
        through_run_with:
          seq.meta.sourceId === '3' || seq.meta.sourceId === '11' ? '3/11' : undefined
      }
    });

    for (let i = 0; i < patternStopIds.length - 1; i++) {
      const a = patternStationIds[i];
      const b = patternStationIds[i + 1];
      const aStop = patternStopIds[i];
      const bStop = patternStopIds[i + 1];
      const plannedEdge =
        (stops.find((s) => s.id === aStop)?.extras as { planned_extension?: boolean } | undefined)
          ?.planned_extension === true ||
        (stops.find((s) => s.id === bStop)?.extras as { planned_extension?: boolean } | undefined)
          ?.planned_extension === true;
      segments.push({
        id: `${NETWORK_ID}-seg-${aStop}-${bStop}`,
        line_id: lineId,
        from_stop_id: aStop,
        to_stop_id: bStop,
        from_station_id: a,
        to_station_id: b,
        direction: 'both',
        extras: plannedEdge ? { planned_extension: true } : undefined
      });
    }

    // First/last trains from official times (operating stations only).
    for (let i = 0; i < ordered.length; i++) {
      const mapId = ordered[i];
      const phys = physByName.get(names.get(mapId)?.zh?.trim() ?? '');
      const stopId = stopByLineMapId.get(`${lineId}|${mapId}`);
      if (!phys || !stopId || phys.status !== 'operating') continue;
      if (seq.meta.status !== 'operating') continue;
      const lineSourceId = seq.meta.sourceId;
      const blocks = times.get(mapId) ?? times.get(baseCode(mapId)) ?? [];
      for (const block of blocks) {
        if (block.lineID !== lineSourceId && block.lineID !== String(lineSourceId)) continue;
        const destCandidates: [string | undefined, string | undefined][] = [
          [block.downDirectionID, block.down_begintime],
          [block.upDirectionID, block.up_begintime]
        ];
        for (const [destMapId, first] of destCandidates) {
          if (!destMapId) continue;
          const destStation =
            stationIdByMapId.get(destMapId) ?? stationIdByMapId.get(baseCode(destMapId));
          const firstT = firstTime(first);
          const lastT =
            destMapId === block.downDirectionID
              ? firstTime(block.down_endtime)
              : firstTime(block.up_endtime);
          if (!firstT && !lastT) continue;
          const aligned = alignTimes(firstT, lastT);
          if (aligned.first.length === 0 || aligned.last.length === 0) continue;
          const destStop =
            stopByLineMapId.get(`${lineId}|${destMapId}`) ??
            stopIdByMapId.get(destMapId) ??
            patternStopIds.find((sid) => {
              const st = stops.find((s) => s.id === sid);
              return st?.station_id === destStation;
            });
          const id = `${NETWORK_ID}-${phys.id}-${short}-to-${asciiSlug(destMapId)}-${i}`;
          if (ttIds.has(id)) continue;
          ttIds.add(id);
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            station_code: baseCode(mapId),
            source_id: mapId,
            destination_stop_id: destStop ?? patternStopIds[patternStopIds.length - 1],
            pattern_id: patternId,
            first_train: aligned.first,
            last_train: aligned.last,
            service: 'all_days',
            direction_type: 'linear'
          });
        }
      }
    }
  }

  /**
   * `N延线` → non-primary pattern on parent line N. Connector reuses the
   * parent terminus **stop_id**; planned stations are new stops on line N.
   */
  for (const meta of extensionMetas) {
    const own = orderedStopMapIds.get(meta.index) ?? [];
    if (own.length === 0) continue;
    const extNo = /^(\d+)\s*延线/.exec(meta.nameZh)?.[1];
    if (!extNo) continue;
    const parentLineId = operatingLineIdByNo.get(extNo);
    if (!parentLineId) continue;
    const parentMeta = lineMetas.find((m) => lineIdByIndex.get(m.index) === parentLineId);
    const parentOrdered = (parentMeta ? orderedStopMapIds.get(parentMeta.index) : []) ?? [];
    if (parentOrdered.length === 0) continue;
    const first = parentOrdered[0];
    const last = parentOrdered[parentOrdered.length - 1];
    const short = parentLineId.replace(`${NETWORK_ID}-line-`, '');

    const distTo = (parentMapId: string | undefined): number => {
      if (!parentMapId) return Number.POSITIVE_INFINITY;
      const p = schematicByMapId.get(parentMapId);
      if (!p) return Number.POSITIVE_INFINITY;
      let best = Number.POSITIVE_INFINITY;
      for (const id of own) {
        const e = schematicByMapId.get(id);
        if (!e) continue;
        best = Math.min(best, Math.hypot(e.x - p.x, e.y - p.y));
      }
      return best;
    };

    const dFirst = distTo(first);
    const dLast = distTo(last);
    const attachAtEnd = Number.isFinite(dLast) && dLast <= dFirst;
    const connectorMapId = attachAtEnd ? last : first;
    const connectorStopId =
      stopByLineMapId.get(`${parentLineId}|${connectorMapId}`) ?? stopIdByMapId.get(connectorMapId);
    if (!connectorStopId) continue;

    // Planned stops on the parent line (same line_id → no fake transfer).
    const extStopIds: string[] = [];
    const extStationIds: string[] = [];
    const parentStopCount = stops.filter((s) => s.line_id === parentLineId).length;
    let seq = parentStopCount;
    for (const mapId of own) {
      const phys = physByName.get(names.get(mapId)?.zh?.trim() ?? '');
      if (!phys) continue;
      const stopId = `${phys.id}-${short}`;
      stopIdByMapId.set(mapId, stopId);
      stopByLineMapId.set(`${parentLineId}|${mapId}`, stopId);
      extStopIds.push(stopId);
      extStationIds.push(phys.id);
      const sch = schematicByMapId.get(mapId);
      stops.push({
        id: stopId,
        station_id: phys.id,
        line_id: parentLineId,
        sequence: seq++,
        is_terminal: false,
        source_id: baseCode(mapId),
        schematic: sch ? { x: sch.x, y: sch.y, crs: 'schematic' } : undefined,
        extras: {
          planned_extension: true,
          map_corridor: meta.nameZh,
          parent_line_no: extNo,
          extension_pattern: true
        }
      });
    }
    if (extStopIds.length === 0) continue;

    // Official order on the map: extension runs outward from the connector.
    const seqStopIds = attachAtEnd
      ? [connectorStopId, ...extStopIds]
      : [...extStopIds, connectorStopId];
    const seqStationIds = attachAtEnd
      ? [stops.find((s) => s.id === connectorStopId)?.station_id ?? '', ...extStationIds]
      : [...extStationIds, stops.find((s) => s.id === connectorStopId)?.station_id ?? ''];

    const extSlug = slug(meta.nameZh) || `ext-${extNo}`;
    const patternId = `${parentLineId}-pattern-ext-${extSlug}`;
    patterns.push({
      id: patternId,
      line_id: parentLineId,
      name: meta.nameZh,
      names: { zh: meta.nameZh, en: officialLineEnglishName(meta.nameZh, meta.nameEn) },
      stop_ids: seqStopIds,
      origin_stop_id: seqStopIds[0],
      terminal_stop_id: seqStopIds[seqStopIds.length - 1],
      is_primary: false,
      junction_stop_id: connectorStopId,
      source_ids: [{ source: 'sz-mtr-map-js', id: meta.sourceId }],
      extras: {
        pattern_status: 'under_construction',
        map_corridor: meta.nameZh,
        parent_line_id: parentLineId,
        connector_station_id: stops.find((s) => s.id === connectorStopId)?.station_id,
        official_extension: true
      }
    });

    // Map-connectivity segments on the parent line (routing skips planned stations).
    for (let i = 0; i < seqStopIds.length - 1; i++) {
      const aStop = seqStopIds[i];
      const bStop = seqStopIds[i + 1];
      const a = seqStationIds[i];
      const b = seqStationIds[i + 1];
      const segId = `${NETWORK_ID}-seg-${aStop}-${bStop}`;
      if (segments.some((s) => s.id === segId || s.id === `${NETWORK_ID}-seg-${bStop}-${aStop}`)) {
        continue;
      }
      segments.push({
        id: segId,
        line_id: parentLineId,
        from_stop_id: aStop,
        to_stop_id: bStop,
        from_station_id: a,
        to_station_id: b,
        direction: 'both',
        extras: { planned_extension: true, pattern_id: patternId, map_corridor: meta.nameZh }
      });
    }

    // Collect extension pattern refs; Line extras are immutable so we map later.
    extLineExtrasByCorridor.set(meta.nameZh, {
      parent_line_id: parentLineId,
      extension_pattern_id: patternId,
      connector_stop_id: connectorStopId,
      stops_owned: 0
    });
  }

  const linesOut = lineRecords.map((l) => {
    const ext = extLineExtrasByCorridor.get(l.name);
    if (!ext) return l;
    return { ...l, extras: { ...(l.extras ?? {}), ...ext } };
  });

  // Same-station line-to-line transfers + 3/11 through-run at 唯亭.
  const linesByStation = new Map<string, { lineId: string; stopId: string; lineName: string }[]>();
  for (const stop of stops) {
    const list = linesByStation.get(stop.station_id) ?? [];
    if (!list.some((x) => x.lineId === stop.line_id)) {
      const line = lineRecords.find((l) => l.id === stop.line_id);
      list.push({
        lineId: stop.line_id,
        stopId: stop.id,
        lineName: line?.name ?? stop.line_id
      });
    }
    linesByStation.set(stop.station_id, list);
  }

  const THROUGH_STATIONS = new Set(['唯亭']);
  for (const [stationId, list] of linesByStation) {
    if (list.length < 2) continue;
    const phys = [...physByName.values()].find((p) => p.id === stationId);
    const zh = phys?.zh ?? '';
    const isThrough = THROUGH_STATIONS.has(zh);
    // Official note: 3号线与11号线贯通运行，常规列车无需下车.
    const walk = isThrough ? 0 : undefined;
    for (const a of list) {
      for (const b of list) {
        if (a.lineId === b.lineId) continue;
        const throughPair =
          isThrough &&
          ((a.lineName.includes('3') && b.lineName.includes('11')) ||
            (a.lineName.includes('11') && b.lineName.includes('3')));
        transfers.push({
          id: `${NETWORK_ID}-xfer-${a.stopId}-${b.stopId}`,
          station_id: stationId,
          from_line_id: a.lineId,
          to_line_id: b.lineId,
          from_stop_id: a.stopId,
          to_stop_id: b.stopId,
          walk_time_seconds: throughPair ? 0 : walk,
          is_out_of_station: false,
          source_id: throughPair ? 'sz-mtr-through-run-3-11' : 'sz-mtr-same-station',
          extras: throughPair
            ? {
                through_run: true,
                note_zh: '3号线与11号线贯通运行，常规列车无需下车'
              }
            : undefined
        });
      }
    }
  }

  const stopStationIds = new Set(stops.map((s) => s.station_id));
  const stopLinesByStation = new Map<string, string[]>();
  for (const s of stops) {
    const list = stopLinesByStation.get(s.station_id) ?? [];
    const line = lineRecords.find((l) => l.id === s.line_id);
    if (line && !list.includes(line.name)) list.push(line.name);
    stopLinesByStation.set(s.station_id, list);
  }
  for (const phys of physByName.values()) {
    if (!stopStationIds.has(phys.id)) continue;
    // Stops sit on the parent operating line; official map corridor stays in extras.
    const displayLines =
      stopLinesByStation.get(phys.id) ?? [...phys.lineNos].filter((n) => !n.includes('延线'));
    const mapCorridors = [...phys.lineNos].filter((n) => n.includes('延线'));
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en || phys.zh },
      status: phys.status,
      source_ids: [...phys.mapIds].map((mid) => ({ source: 'sz-mtr-map-js', id: mid })),
      extras: {
        pinyin: phys.pinyin || undefined,
        official_codes: [...phys.codes].sort(),
        lines: displayLines,
        map_corridor: mapCorridors.length ? mapCorridors.join(',') : undefined,
        planned_extension: phys.status === 'under_construction' && mapCorridors.length > 0
      }
    });
  }

  return {
    network: {
      id: NETWORK_ID,
      name: '苏州轨道交通',
      names: { zh: '苏州轨道交通', en: 'Suzhou Rail Transit' },
      city: {
        id: 'CN-32',
        name: { zh: '苏州', en: 'Suzhou' },
        country: 'CN',
        population: 12911000,
        area: 8657.32,
        location: { type: 'Point', coordinates: [120.58529, 31.29888] }
      },
      country_code: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      coordinate_system: 'gcj02',
      default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
      routing: {
        weight: 'time',
        // Official map note: transfer assumed at 5 minutes when unpublished.
        default_transfer_seconds: 300,
        max_transfer_seconds: 900
      },
      notes:
        '3号线与11号线贯通运营，常规列车无需在唯亭下车换乘。票价：起步价2元可乘6公里；6～16公里每1元可乘5公里；16～30公里每1元可乘7公里；30公里以上每1元可乘9公里。'
    },
    lines: linesOut,
    stations,
    stops,
    patterns,
    segments,
    transfers,
    timetables: timetables.filter(hasValidTimes),
    fareCodesByStationId
  };
}
