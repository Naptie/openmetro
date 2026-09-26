import {
  deriveLineEnglishName,
  foldStationName,
  pinyinToEnglish,
  readableSlug,
  resolveLineShortName,
  stationIdFor,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import {
  type AmapLine,
  type AmapStation,
  type ChongqingSources,
  type CqTimetableLine,
  LINE_CONFIGS,
  parseCell,
  parseStationsByLine,
  parseStationsCoords
} from './fetch.js';

const NETWORK_ID = 'cn-chongqing';
const CQ_SOURCE = 'cqmetro-official';
const AMAP_SOURCE = 'amap-subway-5000';

export interface ChongqingCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}


function lineIdFor(shortName: string, name: string): string {
  const ascii = shortName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${NETWORK_ID}-line-${ascii || readableSlug(name)}`;
}


function resolveEnglishName(
  amapEn: string | undefined,
  pinyin: string | undefined,
  zh: string
): string {
  const en = (amapEn ?? '').trim();
  if (en && /^[A-Za-z]/.test(en)) return en;
  return pinyinToEnglish(pinyin) ?? zh.trim();
}


function parseAmapSl(sl: string | undefined): { lon: number; lat: number } | undefined {
  if (!sl) return undefined;
  const [lonRaw, latRaw] = sl.split(',');
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

/** Official page line keys ("江跳线(市郊铁路)") → config name ("江跳线"). */
function matchConfig(officialName: string) {
  const bare = officialName.replace(/[（(].*$/, '').trim();
  return LINE_CONFIGS.find((c) => c.name === bare || officialName.includes(c.name));
}

function parseTimeCell(text: string): string | undefined {
  const t = text.trim();
  if (!t || t === '--' || t === '—' || t === '-') return undefined;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 25 || mm > 59) return undefined;
  return `${String(hh).padStart(2, '0')}:${m[2]}`;
}

/** One service direction at a station: destination + first/last train. */
export interface TimetableDirection {
  /** Destination station name (folded zh), e.g. "刘家坪". */
  dest: string;
  first?: string;
  last?: string;
}

export interface TimetableRowParsed {
  station: string;
  directions: TimetableDirection[];
}

export interface TimetableSections {
  /** One section per service branch; consecutive rows between `--` markers. */
  sections: TimetableRowParsed[][];
}

export function parseTimetableTable(rows: Record<string, unknown>[]): TimetableRowParsed[] {
  return parseTimetableSections(rows).sections.flat();
}

function destFromLabel(raw: string): string | undefined {
  const t = raw
    .trim()
    .replace(/[↑↓↑↓↔→←·]/g, '')
    .trim();
  if (!t || /^(首|末|工作|节假|双休|站点|站名|时刻)/.test(t)) return undefined;
  const m = t.match(/^往(.+)$/);
  const name = (m ? m[1]! : t).trim();
  if (!name) return undefined;
  return foldStationName(name);
}

interface ColMeta {
  dest?: string;
  kind?: 'first' | 'last';
}

/**
 * Split the official table into sections and parse per-column direction
 * metadata. The operator separates a branch (e.g. 6号线东站段) from the main
 * alignment with `--` filler rows — that split is the true topology; the flat
 * station list JS is not.
 *
 * Time columns are not (first, last) pairs. Within each day-type block the
 * layout is first-train columns then last-train columns, each labelled
 * `往X↓` / `往Y↑` (see 6号线 / 2号线 / 环线 headers). When no labels are
 * present the common 4-column block is
 * `[firstTowardSectionEnd, firstTowardSectionStart, lastTowardSectionEnd, lastTowardSectionStart]`.
 */
export function parseTimetableSections(rows: Record<string, unknown>[]): TimetableSections {
  const sections: TimetableRowParsed[][] = [];
  let current: TimetableRowParsed[] = [];
  let colMeta = new Map<number, ColMeta>();
  let sawLabels = false;

  const push = () => {
    if (current.length > 0) {
      if (!sawLabels) applyFallbackDests(current);
      sections.push(current);
    }
    current = [];
    colMeta = new Map();
    sawLabels = false;
  };

  const metaAt = (col: number): ColMeta => {
    let m = colMeta.get(col);
    if (!m) {
      m = {};
      colMeta.set(col, m);
    }
    return m;
  };

  const scanKindRow = (r: Record<string, unknown>) => {
    let col = 2;
    for (let c = 2; c <= 40; c++) {
      if (c < col) continue;
      const cell = parseCell(r[`col${c}`]);
      if (!cell) {
        if (c === col) col = c + 1;
        continue;
      }
      const text = cell.text.trim();
      const span = Math.max(1, cell.colspan || 1);
      if (/首班车/.test(text) || /首班/.test(text)) {
        for (let k = 0; k < span; k++) metaAt(col + k).kind = 'first';
        col = col + span;
      } else if (/末班车/.test(text) || /末班/.test(text)) {
        for (let k = 0; k < span; k++) metaAt(col + k).kind = 'last';
        col = col + span;
      } else if (text) {
        col = col + span;
      } else {
        col = Math.max(col, c + span);
      }
    }
  };

  const scanLabelRow = (r: Record<string, unknown>): boolean => {
    let found = false;
    for (let c = 2; c <= 40; c++) {
      const cell = parseCell(r[`col${c}`]);
      if (!cell) continue;
      const dest = destFromLabel(cell.text);
      if (!dest) continue;
      metaAt(c).dest = dest;
      found = true;
    }
    return found;
  };

  for (const r of rows) {
    if (r.isBz === 1) continue;
    const cell = parseCell(r.col1);
    const text = (cell?.text ?? '').trim();
    const isSep = text === '--' || text === '—' || text === '-';
    const isHeader = /^(站点|站名)/.test(text);

    if (isHeader) {
      colMeta = new Map();
      sawLabels = false;
      continue;
    }

    // Blank-name rows are headers (首/末 or 往X) or filler.
    if (!text || isSep) {
      const joined = [
        text,
        ...Array.from({ length: 12 }, (_, i) => parseCell(r[`col${i + 2}`])?.text ?? '')
      ].join(' ');
      if (/首班|末班/.test(joined)) {
        scanKindRow(r);
        if (isSep && current.length > 0) push();
        continue;
      }
      const labeled = scanLabelRow(r);
      if (labeled) {
        sawLabels = true;
        // Direction labels announce a new service section (6号线东站段).
        if (current.length > 0) push();
        continue;
      }
      if (isSep) {
        push();
        continue;
      }
      continue;
    }

    // Data row: rebuild per-direction first/last from column metadata.
    const byDest = new Map<string, TimetableDirection>();
    for (let c = 2; c <= 40; c++) {
      const raw = parseCell(r[`col${c}`])?.text ?? '';
      const time = parseTimeCell(raw);
      if (!time) continue;
      const meta = colMeta.get(c) ?? {};
      let dest = meta.dest;
      if (!dest) {
        // Fallback block of 4: [firstEnd, firstStart, lastEnd, lastStart].
        const block = (c - 2) % 4;
        const isEnd = block === 0 || block === 2;
        dest = isEnd ? '\u0000end' : '\u0000start';
      }
      const dir = byDest.get(dest) ?? { dest };
      const kind: 'first' | 'last' =
        meta.kind ?? ((c - 2) % 4 === 0 || (c - 2) % 4 === 1 ? 'first' : 'last');
      if (kind === 'first') {
        if (!dir.first) dir.first = time;
      } else if (!dir.last) {
        dir.last = time;
      }
      byDest.set(dest, dir);
    }

    const directions = [...byDest.values()].filter((d) => d.first || d.last);
    if (directions.length > 0) {
      current.push({ station: text, directions });
    }
  }
  push();
  return { sections };
}

/** Resolve `\u0000end` / `\u0000start` placeholders from the section termini. */
function applyFallbackDests(section: TimetableRowParsed[]): void {
  if (section.length === 0) return;
  const start = foldStationName(section[0]!.station);
  const end = foldStationName(section[section.length - 1]!.station);
  for (const row of section) {
    for (const d of row.directions) {
      if (d.dest === '\u0000end') d.dest = end;
      else if (d.dest === '\u0000start') d.dest = start;
    }
  }
}

export function normalizeChongqing(input: ChongqingSources): ChongqingCanonical {
  const officialLines = parseStationsByLine(input.stationsJs);
  const officialCoords = parseStationsCoords(input.stationCoordsJs);

  // Index AMap by folded Chinese name.
  const amapByName = new Map<
    string,
    { en?: string; sp?: string; lon?: number; lat?: number; poiid?: string }
  >();
  for (const line of (input.amap.l ?? []) as AmapLine[]) {
    for (const st of (line.st ?? []) as AmapStation[]) {
      const zh = foldStationName(st.n ?? '');
      if (!zh) continue;
      const sl = parseAmapSl(st.sl);
      const prev = amapByName.get(zh);
      amapByName.set(zh, {
        en: st.en || st.multilang?.n?.en || prev?.en,
        sp: st.sp || prev?.sp,
        lon: sl?.lon ?? prev?.lon,
        lat: sl?.lat ?? prev?.lat,
        poiid: st.poiid || prev?.poiid
      });
    }
  }

  // Physical stations (unique by folded name).
  const stationByZh = new Map<string, StationEncoded>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const stationIdByZh = new Map<string, string>();

  const upsertStation = (zhRaw: string): string => {
    const zh = foldStationName(zhRaw);
    const existingId = stationIdByZh.get(zh);
    if (existingId) return existingId;
    const amap = amapByName.get(zh);
    const en = resolveEnglishName(amap?.en, amap?.sp, zh);
    const id = `${NETWORK_ID}-${stationIdFor(en, zh)}`;
    // Avoid collisions.
    let unique = id;
    let n = 2;
    while (stationByZh.has(unique)) unique = `${id}-${n++}`;
    stationIdByZh.set(zh, unique);

    const coordJs = officialCoords['环线']?.[zhRaw] ?? findCoord(officialCoords, zhRaw);
    const location =
      amap?.lon != null && amap?.lat != null
        ? { lon: amap.lon, lat: amap.lat, crs: 'gcj02' as const }
        : coordJs
          ? // Official JS comment says Baidu picker (BD-09); treat as GCJ-02
            // fallback only when AMap is missing — geocode chain will replace.
            { lon: coordJs[0], lat: coordJs[1], crs: 'gcj02' as const }
          : undefined;
    if (location) officialLocations.set(unique, location);

    const station: StationEncoded = {
      id: unique,
      name: zh,
      names: { zh, en },
      status: 'operating',
      source_ids: [{ source: CQ_SOURCE, id: zhRaw }],
      location,
      extras: {
        location_source: location ? 'amap' : undefined,
        location_provider: amap?.poiid ? 'amap_subway' : undefined,
        names_source: 'source'
      }
    };
    stationByZh.set(zh, station);
    return unique;
  };

  function findCoord(
    map: Record<string, Record<string, [number, number]>>,
    zh: string
  ): [number, number] | undefined {
    for (const lineStations of Object.values(map)) {
      const hit = lineStations[zh];
      if (hit) return hit;
    }
    return undefined;
  }

  const lines: LineEncoded[] = [];
  const stops: StopEncoded[] = [];
  const stopById = new Map<string, StopEncoded>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const timetableByLine = new Map<number, CqTimetableLine>();
  for (const t of input.timetables) timetableByLine.set(t.lineSid, t);

  for (const cfg of LINE_CONFIGS) {
    // Official page key may include a parenthetical suffix.
    const officialKey =
      Object.keys(officialLines).find((k) => {
        const bare = k.replace(/[（(].*$/, '').trim();
        return bare === cfg.name || k === cfg.name || matchConfig(k)?.name === cfg.name;
      }) ?? cfg.name;
    const stationNames = officialLines[officialKey] ?? officialLines[cfg.name] ?? [];
    if (stationNames.length === 0) {
      console.warn(`  no official stations for ${cfg.name}`);
      continue;
    }

    const lineId = lineIdFor(cfg.shortName, cfg.name);
    const enName = deriveLineEnglishName(cfg.name, cfg.shortName) ?? cfg.name;
    const line: LineEncoded = {
      id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: enName },
      aliases: [],
      color: cfg.color,
      short_name: resolveLineShortName(cfg.name, cfg.shortName),
      mode: cfg.mode,
      status: 'operating',
      loop: Boolean(cfg.loop),
      source_ids: [{ source: CQ_SOURCE, id: String(cfg.lineSid) }]
    };
    lines.push(line);

    // Topology: prefer the official timetable's section split (it separates a
    // branch from the main alignment). The flat stationsByLine JS is a single
    // list and scrambles 6号线 + 6号线东站段 into one zigzag chain.
    const ttRaw = timetableByLine.get(cfg.lineSid);
    const sections = ttRaw?.scheduls?.length
      ? parseTimetableSections(ttRaw.scheduls).sections.filter((s) => s.length >= 2)
      : [];
    const primaryNames: string[] =
      sections.length > 0 ? sections[0]!.map((r) => r.station) : stationNames;

    const stopIdByName = new Map<string, string>();
    const ensureStop = (zhRaw: string): string => {
      const zh = foldStationName(zhRaw);
      const existing = stopIdByName.get(zh);
      if (existing) return existing;
      const stationId = upsertStation(zhRaw);
      const stopId = stationId + '-' + cfg.shortName;
      stops.push({
        id: stopId,
        station_id: stationId,
        line_id: lineId,
        // Unique within the line (verify requires it); assigned in build order.
        sequence: stops.filter((s) => s.line_id === lineId).length + 1,
        source_id: CQ_SOURCE
      });
      stopIdByName.set(zh, stopId);
      stopById.set(stopId, stops[stops.length - 1]!);
      return stopId;
    };

    const stopIds: string[] = [];
    for (const zhRaw of primaryNames) {
      const sid = ensureStop(zhRaw);
      if (!stopIds.includes(sid)) stopIds.push(sid);
    }

    const patternId = lineId + '-primary';
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: { zh: cfg.name, en: enName },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      color: cfg.color,
      source_ids: [{ source: CQ_SOURCE, id: String(cfg.lineSid) }]
    });

    // Branch patterns (e.g. 6号线东站段): order so the junction stop is first.
    for (let si = 1; si < sections.length; si++) {
      const rows = sections[si]!;
      const branchNames = rows.map((r) => r.station);
      const primaryStationIds = new Set(stopIds.map((id) => stopById.get(id)!.station_id));
      const junctionIdx = branchNames.findIndex((n) => primaryStationIds.has(upsertStation(n)));
      // Official branch tables list stations in one direction of travel. Put
      // the junction first and keep the remaining stations in geographic order
      // away from it: when the section *ends* at the junction the list is
      // toward the trunk and must be reversed.
      let ordered: string[];
      if (junctionIdx < 0) {
        ordered = [...branchNames];
      } else if (junctionIdx === branchNames.length - 1) {
        ordered = [...branchNames].reverse();
      } else if (junctionIdx === 0) {
        ordered = [...branchNames];
      } else {
        ordered = [...branchNames.slice(junctionIdx), ...branchNames.slice(0, junctionIdx)];
      }
      const branchStopIds = ordered.map((n) => ensureStop(n));
      const junctionStopId = branchStopIds[0]!;
      const bpId = lineId + '-branch-' + si;
      patterns.push({
        id: bpId,
        line_id: lineId,
        name: cfg.name + '支' + si,
        names: { zh: cfg.name + '支' + si, en: enName + ' Branch ' + si },
        stop_ids: branchStopIds,
        origin_stop_id: junctionStopId,
        terminal_stop_id: branchStopIds[branchStopIds.length - 1]!,
        is_primary: false,
        junction_stop_id: junctionStopId,
        color: cfg.color,
        source_ids: [{ source: CQ_SOURCE, id: String(cfg.lineSid) }]
      });
    }

    // Consecutive ride edges (direction=both) over every pattern of this line.
    for (const p of patterns.filter((x) => x.line_id === lineId)) {
      for (let i = 0; i < p.stop_ids.length - 1; i++) {
        const a = stops.find((s) => s.id === p.stop_ids[i])!;
        const b = stops.find((s) => s.id === p.stop_ids[i + 1])!;
        const segId = NETWORK_ID + '-seg-' + a.id + '-' + b.id;
        if (segments.some((s) => s.id === segId)) continue;
        segments.push({
          id: segId,
          line_id: lineId,
          from_stop_id: a.id,
          to_stop_id: b.id,
          from_station_id: a.station_id,
          to_station_id: b.station_id,
          direction: 'both',
          source_id: CQ_SOURCE
        });
      }
    }

    // Timetables from official first/last JSON, one dest per service direction.
    // Section 0 maps onto the primary pattern; later sections onto their branch.
    const tt = timetableByLine.get(cfg.lineSid);
    if (tt?.scheduls?.length) {
      const parsedSections = parseTimetableSections(tt.scheduls).sections.filter(
        (s) => s.length >= 2
      );
      for (let si = 0; si < parsedSections.length; si++) {
        const sectionRows = parsedSections[si]!;
        const sectionPattern =
          si === 0
            ? patterns.find((p) => p.id === patternId)!
            : patterns.find((p) => p.id === lineId + '-branch-' + si);
        if (!sectionPattern) continue;
        const stationById = new Map([...stationByZh.values()].map((s) => [s.id, s] as const));
        const stopIdByFold = new Map<string, string>();
        for (const sid of sectionPattern.stop_ids) {
          const st = stopById.get(sid);
          if (!st) continue;
          const station = stationById.get(st.station_id);
          const zh = station?.name ?? station?.names.zh ?? st.station_id;
          stopIdByFold.set(foldStationName(zh), sid);
        }
        for (const row of sectionRows) {
          const rowFold = foldStationName(row.station);
          const stationId = stationIdByZh.get(rowFold);
          if (!stationId) continue;
          const stopId = stopIdByFold.get(rowFold);
          if (!stopId) continue;
          for (const dir of row.directions) {
            const destStopId = stopIdByFold.get(foldStationName(dir.dest));
            if (!destStopId || destStopId === stopId) continue;
            if (!(dir.first || dir.last)) continue;
            const id = `${stopId}|${destStopId}`;
            if (timetables.some((t) => t.id === id)) continue;
            timetables.push({
              id,
              station_id: stationId,
              stop_id: stopId,
              line_id: lineId,
              destination_stop_id: destStopId,
              pattern_id: sectionPattern.id,
              direction_type: cfg.loop ? 'linear' : 'linear',
              direction_label: cfg.loop ? (sectionPattern.is_primary ? '内环' : '外环') : undefined,
              first_train: dir.first ? [dir.first] : [],
              last_train: dir.last ? [dir.last] : [],
              source_id: CQ_SOURCE
            });
          }
        }
      }
    }
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '重庆轨道交通',
    names: { zh: '重庆轨道交通', en: 'Chongqing Rail Transit' },
    city: {
      id: 'CN-50',
      name: { zh: '重庆', en: 'Chongqing' },
      country: 'CN',
      population: null,
      area: null,
      location: {
        type: 'Point',
        coordinates: [106.55, 29.56]
      }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: {
      weight: 'time',
      default_transfer_seconds: 180,
      max_transfer_seconds: 720
    }
  };

  return {
    network,
    lines,
    stations: [...stationByZh.values()],
    stops,
    patterns,
    segments,
    transfers: [] as TransferEncoded[],
    timetables,
    officialLocations
  };
}
