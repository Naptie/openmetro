import {
  asciiSlug,
  cleanTime,
  foldStationName,
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
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded,
  type TransferEncoded,
  titleCaseRoman
} from '@openmetro/core';
import type {
  AmapLine,
  AmapStation,
  XianOfficialLine,
  XianOfficialStation,
  XianSources,
  XianStationTrainTime
} from './fetch.js';

const NETWORK_ID = 'cn-xian';
const XA_SOURCE = 'xianrail-pas-gateway';
const AMAP_SOURCE = 'amap-subway-6101';

export interface XianCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Physical station id → one official per-line stationId (fare planner key). */
  fareStationCode: Map<string, string>;
}

/** `"咸阳西站方向"` → `"咸阳西站"`; `"内环"` stays. */
function destFromDirection(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const t = label.replace(/方向$/, '').trim();
  const m = /^往(.+)$/.exec(t);
  return (m ? m[1].trim() : t) || undefined;
}

/**
 * Official English names are unreliable (placeholders `x`, copy-paste
 * `XI'ANBEIZHAN`). Prefer clean AMap pinyin, then a usable official string,
 * then the hand map — never fall back to the Chinese name.
 */
function resolveEnglishName(
  officialEn: string | null | undefined,
  amapPinyin: string | undefined,
  amapEn: string | undefined,
  _zh: string
): string | undefined {
  const fromPinyin = pinyinToEnglish(amapPinyin) ?? pinyinToEnglish(amapEn);
  if (fromPinyin) return fromPinyin;
  const off = (officialEn ?? '').trim();
  if (isUsableEnglish(off) && /^[A-Za-z]/.test(off)) {
    return titleCaseRoman(off.replace(/([a-z])([A-Z])/g, '$1 $2'));
  }
  // Wikidata fillMissingEnglish in run.ts supplies the rest — never invent names.
  return undefined;
}

function lineIdFromShort(short: string): string {
  const numbered = /^(\d+)号线?$/.exec(short.trim());
  if (numbered) return `${NETWORK_ID}-line-${numbered[1]}`;
  if (/西户/.test(short)) return `${NETWORK_ID}-line-xihu`;
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  const numbered = /^(\d+)号线?$/.exec(short.trim());
  const tag = numbered ? numbered[1]! : /西户/.test(short) ? 'xihu' : asciiSlug(short);
  return `${stationId}-${tag}`;
}

function amapLineByName(amap: XianSources['amap']): Map<string, AmapLine> {
  const by = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln) by.set(ln, line);
    // Official "8号线" vs AMap "8号(环)线"
    const m = /^(\d+)号/.exec(ln);
    if (m && !by.has(`${m[1]}号线`)) by.set(`${m[1]}号线`, line);
  }
  return by;
}

function amapStationsByName(amap: XianSources['amap']): Map<string, AmapStation> {
  const by = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!by.has(key)) by.set(key, st);
    }
  }
  return by;
}

/** AMap may publish composite/renamed labels; official name is often a part. */
function findAmapByContainment(
  byFold: Map<string, AmapStation>,
  key: string
): AmapStation | undefined {
  if (!key) return undefined;
  const exact = byFold.get(key);
  if (exact) return exact;
  for (const [k, st] of byFold) {
    if (k.includes(key) || key.includes(k)) return st;
  }
  return undefined;
}

/** Official feed leaves 换乘站 blank on the loop line — AMap `r` is authoritative there. */
function amapInterchangeLines(st: AmapStation | undefined): string[] {
  if (!st?.r) return [];
  return String(st.r)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function shortFromOfficialName(line: XianOfficialLine): string {
  const official = line.lineShortName?.trim();
  // Prefer a compact badge ("1", "西户"); strip the redundant 号线 suffix.
  if (official) {
    const compact = official.replace(/^地铁/, '').replace(/号线$/, '');
    if (compact) return compact;
  }
  return resolveLineShortName(line.lineName);
}

function isLoopLine(line: XianOfficialLine): boolean {
  return /环/.test(line.lineName) || line.lineId === '08';
}

function isSuburban(line: XianOfficialLine): boolean {
  return line.lineId === '50' || /西户/.test(line.lineName);
}

function parseHHMM(t: string | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  // Official feed writes after-midnight last trains as 00:xx (service-day 24:xx).
  if (h < 4) h += 24;
  return h * 60 + min;
}

function formatHHMM(mins: number): string {
  const m = Math.round(mins);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Interpolate missing first/last trains along each line×direction so sparse
 * official feeds (e.g. Xi'an Line 1 Xianyang extension) still cover every
 * station. A line that cannot reach full coverage is dropped wholesale.
 */
function fillTimetableGaps(
  timetables: TimetableEncoded[],
  patterns: PatternEncoded[],
  stops: StopEncoded[],
  _unused?: unknown
): TimetableEncoded[] {
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const _patternById = new Map(patterns.map((p) => [p.id, p]));
  const out: TimetableEncoded[] = [];
  const byLine = new Map<string, TimetableEncoded[]>();
  for (const t of timetables) {
    const list = byLine.get(t.line_id) ?? [];
    list.push(t);
    byLine.set(t.line_id, list);
  }

  for (const [lineId, rows] of byLine) {
    const pattern = patterns.find((p) => p.line_id === lineId && p.is_primary);
    const order = pattern?.stop_ids ?? [];
    if (order.length === 0) {
      out.push(...rows);
      continue;
    }

    // Key directions by destination stop (stable across stations).
    const dirs = new Map<string, TimetableEncoded[]>();
    for (const t of rows) {
      const key = `${t.destination_stop_id ?? ''}|${t.direction_label ?? ''}`;
      const list = dirs.get(key) ?? [];
      list.push(t);
      dirs.set(key, list);
    }

    const filledDirs: TimetableEncoded[] = [];
    for (const [dirKey, dirRows] of dirs) {
      const byStop = new Map(dirRows.map((t) => [t.stop_id, t]));
      const known = order.filter((id) => byStop.has(id));
      if (known.length === 0) continue;

      // Need a substantial official sample before interpolating the rest.
      if (known.length < Math.max(2, Math.ceil(order.length * 0.35))) {
        console.log(
          `  skip sparse direction ${dirKey} on ${lineId} (${known.length}/${order.length})`
        );
        continue;
      }

      const hopFirst: number[] = [];
      const hopLast: number[] = [];
      for (let i = 1; i < known.length; i++) {
        const a = byStop.get(known[i - 1]!)!;
        const b = byStop.get(known[i]!)!;
        const af = parseHHMM(a.first_train[0]);
        const bf = parseHHMM(b.first_train[0]);
        const al = parseHHMM(a.last_train[0]);
        const bl = parseHHMM(b.last_train[0]);
        const gap = order.indexOf(known[i]!) - order.indexOf(known[i - 1]!);
        if (af != null && bf != null && gap > 0) hopFirst.push((bf - af) / gap);
        if (al != null && bl != null && gap > 0) hopLast.push((bl - al) / gap);
      }
      const dFirst = hopFirst.length ? median(hopFirst) : 1.5;
      const dLast = hopLast.length ? median(hopLast) : 1.5;

      for (let i = 0; i < order.length; i++) {
        const stopId = order[i]!;
        if (byStop.has(stopId)) {
          filledDirs.push(byStop.get(stopId)!);
          continue;
        }
        // Nearest known before / after along the pattern.
        let before: TimetableEncoded | undefined;
        let beforeIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          const t = byStop.get(order[j]!);
          if (t) {
            before = t;
            beforeIdx = j;
            break;
          }
        }
        let after: TimetableEncoded | undefined;
        let afterIdx = -1;
        for (let j = i + 1; j < order.length; j++) {
          const t = byStop.get(order[j]!);
          if (t) {
            after = t;
            afterIdx = j;
            break;
          }
        }
        const template = before ?? after;
        if (!template) continue;

        let first: string | undefined;
        let last: string | undefined;
        if (before && after) {
          const bf = parseHHMM(before.first_train[0])!;
          const af = parseHHMM(after.first_train[0])!;
          const bl = parseHHMM(before.last_train[0])!;
          const al = parseHHMM(after.last_train[0])!;
          const span = afterIdx - beforeIdx;
          const w = (i - beforeIdx) / span;
          first = formatHHMM(bf + (af - bf) * w);
          last = formatHHMM(bl + (al - bl) * w);
        } else if (before) {
          const steps = i - beforeIdx;
          const bf = parseHHMM(before.first_train[0]);
          const bl = parseHHMM(before.last_train[0]);
          if (bf != null) first = formatHHMM(bf + dFirst * steps);
          if (bl != null) last = formatHHMM(bl + dLast * steps);
        } else if (after) {
          const steps = afterIdx - i;
          const af = parseHHMM(after.first_train[0]);
          const al = parseHHMM(after.last_train[0]);
          if (af != null) first = formatHHMM(af - dFirst * steps);
          if (al != null) last = formatHHMM(al - dLast * steps);
        }
        if (!first && !last) continue;

        const stop = stopById.get(stopId);
        filledDirs.push({
          ...template,
          id: `${NETWORK_ID}-tt-${stopId}-filled-${dirKey.replace(/[^\w-]+/g, '_')}`,
          stop_id: stopId,
          station_id: stop?.station_id ?? template.station_id,
          station_code: stop?.source_id,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          is_arrival: undefined,
          extras: {
            ...(template.extras ?? {}),
            filled: true,
            filled_from: dirKey
          }
        });
      }
    }

    // Drop the whole line if any stop on the primary pattern lacks a row.
    const stopsCovered = new Set(filledDirs.map((t) => t.stop_id));
    const missing = order.filter((id) => !stopsCovered.has(id));
    if (filledDirs.length === 0 || missing.length > 0) {
      console.log(
        `  drop sparse timetables on ${lineId} (${stopsCovered.size}/${order.length} stops)`
      );
      continue;
    }
    out.push(...filledDirs);
  }
  return out;
}

export function normalizeXian(input: XianSources): XianCanonical {
  const amapByName = amapLineByName(input.amap);
  const amapStationByName = amapStationsByName(input.amap);

  // ---- Lines ----------------------------------------------------------------
  const lineByShort = new Map<string, LineEncoded>();
  const lineIdByOfficial = new Map<string, string>();
  const shortByOfficialLineId = new Map<string, string>();

  for (const line of input.lines) {
    const short = shortFromOfficialName(line);
    shortByOfficialLineId.set(line.lineId, short);
    const lineId = lineIdFromShort(short);
    lineIdByOfficial.set(line.lineId, lineId);
    if (lineByShort.has(short)) continue;

    const amap =
      amapByName.get(line.lineName) ??
      amapByName.get(short) ??
      amapByName.get(`${short.replace(/号线$/, '')}号线`) ??
      amapByName.get(short.replace(/号线$/, ''));
    const rawEn = String(amap?.lb ?? '').trim() || line.lineEnglishName?.trim() || '';
    const numbered = /^(\d+)$/.exec(short);
    const nameEn = numbered
      ? `Line ${numbered[1]}`
      : /西户/.test(short)
        ? 'Xihu Line'
        : rawEn.replace(/^line/i, 'Line') || short;
    const loop = isLoopLine(line);
    const mode = isSuburban(line) ? ('suburban_rail' as const) : ('metro' as const);

    lineByShort.set(short, {
      id: lineId,
      name: line.lineName,
      names: { zh: line.lineName, en: nameEn },
      aliases: [],
      color: hexToCss(amap?.cl ?? line.lineColor ?? undefined),
      short_name: short,
      mode,
      status: 'operating',
      loop,
      source_ids: [
        { source: XA_SOURCE, id: line.lineId },
        ...(amap?.ls ? [{ source: AMAP_SOURCE, id: String(amap.ls) }] : [])
      ],
      extras: {
        official_line_length_km: line.lineLength || undefined,
        amap_color: amap?.cl,
        line_type: line.lineType
      }
    });
  }

  // ---- Physical stations ----------------------------------------------------
  type Phys = {
    id: string;
    zh: string;
    en: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    officialCodes: string[];
    lineShorts: Set<string>;
    pinyin?: string;
    poiid?: string;
    isInterchange: boolean;
    fareCode?: string;
  };
  const physByFold = new Map<string, Phys>();

  const ensurePhys = (zhRaw: string, officialCode: string, officialEn?: string | null): Phys => {
    const zh = zhRaw.trim();
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    const amap = findAmapByContainment(amapStationByName, key);
    if (!phys) {
      const en =
        resolveEnglishName(officialEn, String(amap?.sp ?? ''), String(amap?.en ?? ''), zh) ?? '';
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh)}`,
        zh,
        en,
        location: loc,
        schematic: pix,
        officialCodes: [],
        lineShorts: new Set(),
        pinyin: String(amap?.sp ?? '').trim() || undefined,
        poiid: amap?.poiid || undefined,
        isInterchange: amap ? amapInterchangeLines(amap).length > 1 || amap.t === '1' : false
      };
      physByFold.set(key, phys);
    }
    if (!phys.officialCodes.includes(officialCode)) phys.officialCodes.push(officialCode);
    if (!phys.fareCode) phys.fareCode = officialCode;
    // Keep the best romanisation we have seen for this physical station.
    const better = resolveEnglishName(
      officialEn ?? undefined,
      String(amap?.sp ?? ''),
      String(amap?.en ?? ''),
      phys.zh
    );
    if (better && better !== phys.zh && isUsableEnglish(better)) phys.en = better;
    return phys;
  };

  // Official sequences may include extension-era negatives (Line 2 常宁宫 = -1).
  // Trust numeric downSequence when present; never drop negatives to the end.
  const orderedLines: { line: XianOfficialLine; stations: XianOfficialStation[] }[] =
    input.lines.map((line) => {
      const stations = [...line.stations];
      const hasSeq = stations.some((s) => Number.isFinite(s.downSequence));
      if (hasSeq) {
        stations.sort((a, b) => {
          const sa = Number.isFinite(a.downSequence) ? a.downSequence : 9999;
          const sb = Number.isFinite(b.downSequence) ? b.downSequence : 9999;
          return sa - sb;
        });
      }
      return { line, stations };
    });

  for (const { line, stations } of orderedLines) {
    const short = shortByOfficialLineId.get(line.lineId)!;
    for (const st of stations) {
      const phys = ensurePhys(st.stationName, st.stationId, st.stationEnglishName);
      phys.lineShorts.add(short);
      if (st.stationCharacter === '换乘站') phys.isInterchange = true;
    }
  }
  // AMap interchange union
  for (const phys of physByFold.values()) {
    const amap = findAmapByContainment(amapStationByName, foldStationName(phys.zh));
    if (amap && amapInterchangeLines(amap).length > 1) phys.isInterchange = true;
  }

  // ---- Stops / patterns / segments / timetables -----------------------------
  const stops: StopEncoded[] = [];
  const stopIdSet = new Set<string>();
  const stopIdByPhysLine = new Map<string, string>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeys = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const fareStationCode = new Map<string, string>();

  for (const { line, stations } of orderedLines) {
    const short = shortByOfficialLineId.get(line.lineId)!;
    const lineId = lineIdByOfficial.get(line.lineId)!;
    const lineRec = lineByShort.get(short)!;
    const loop = lineRec.loop;

    const stopIds: string[] = [];
    const stationIds: string[] = [];

    for (let i = 0; i < stations.length; i++) {
      const st = stations[i]!;
      const phys = ensurePhys(st.stationName, st.stationId, st.stationEnglishName);
      const stopId = stopIdOf(phys.id, short);
      if (!stopIdSet.has(stopId)) {
        stopIdSet.add(stopId);
        stops.push({
          id: stopId,
          station_id: phys.id,
          line_id: lineId,
          sequence: i,
          is_terminal: !loop && (i === 0 || i === stations.length - 1),
          source_id: st.stationId,
          schematic: phys.schematic
            ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
            : undefined,
          extras: {
            line_short_name: short,
            station_code: st.stationId,
            station_character: st.stationCharacter ?? undefined
          }
        });
      }
      stopIdByPhysLine.set(`${phys.id}|${short}`, stopId);
      if (!fareStationCode.has(phys.id)) fareStationCode.set(phys.id, st.stationId);
      stopIds.push(stopId);
      stationIds.push(phys.id);
      if (phys.location) {
        officialLocations.set(phys.id, { ...phys.location, crs: 'gcj02' });
      }
    }

    // One pattern per line (reverses are not patterns — direction lives on timetables).
    const patternId = `${lineId}-pattern-main`;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: line.lineName,
      names: { zh: line.lineName, en: lineRec.names.en },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0]!,
      terminal_stop_id: stopIds[stopIds.length - 1]!,
      is_primary: true,
      source_ids: [{ source: XA_SOURCE, id: line.lineId }],
      extras: {
        line_short_name: short,
        loop,
        origin_name: stations[0]?.stationName,
        terminal_name: loop ? stations[0]?.stationName : stations[stations.length - 1]?.stationName
      }
    });

    for (let i = 0; i < stopIds.length - (loop ? 0 : 1); i++) {
      const j = (i + 1) % stopIds.length;
      const a = stopIds[i]!;
      const b = stopIds[j]!;
      if (loop && stopIds.length < 2) break;
      const key = [lineId, a, b].sort().join('|');
      if (segmentKeys.has(key)) continue;
      segmentKeys.add(key);
      segments.push({
        id: `${NETWORK_ID}-seg-${a}-${b}`,
        line_id: lineId,
        from_stop_id: a,
        to_stop_id: b,
        from_station_id: stationIds[i]!,
        to_station_id: stationIds[j]!,
        direction: 'both',
        source_id: XA_SOURCE
      });
    }

    // Timetables from structured getStationInfo only (never OCR images).
    // Transfer stations return every line; keep a cell only when its destination
    // is a station on THIS line (stricter and more reliable than name matching).
    const lineStationKeys = new Set(stations.map((s) => foldStationName(s.stationName)));
    const lineStopIdByFold = new Map<string, string>();
    for (const st of stations) {
      const phys = ensurePhys(st.stationName, st.stationId, st.stationEnglishName);
      const sid = stopIdByPhysLine.get(`${phys.id}|${short}`);
      if (sid) lineStopIdByFold.set(foldStationName(st.stationName), sid);
    }

    for (const st of stations) {
      const info = input.stationInfo.get(st.stationId);
      const rows: XianStationTrainTime[] = info?.trainTime ?? [];
      const phys = ensurePhys(st.stationName, st.stationId, st.stationEnglishName);
      const stopId = stopIdByPhysLine.get(`${phys.id}|${short}`);
      if (!stopId) continue;

      for (const row of rows) {
        for (const cell of row.timeList ?? []) {
          const label = cell.direction?.trim();
          const destName = destFromDirection(label);
          const first = cleanTime(cell.start);
          const last = cleanTime(cell.end);
          if (!first && !last) continue;
          if (!destName) continue;

          const destFold = foldStationName(destName);
          // Own-station direction = terminal arrival at this stop.
          const isSelf = destFold === foldStationName(phys.zh);
          if (!isSelf && !lineStationKeys.has(destFold)) continue;

          const destStopId = isSelf ? stopId : lineStopIdByFold.get(destFold);
          if (!destStopId) continue;

          const id = `${NETWORK_ID}-tt-${stopId}-${asciiSlug(label || destName || 'dir')}`;
          if (ttIds.has(id)) continue;
          ttIds.add(id);

          const isLoopDir = /内环|外环|内圈|外圈/.test(label ?? '');
          timetables.push({
            id,
            station_id: phys.id,
            stop_id: stopId,
            line_id: lineId,
            station_code: st.stationId,
            source_id: XA_SOURCE,
            destination_stop_id: destStopId,
            origin_stop_id: undefined,
            pattern_id: patternId,
            direction_type: isLoopDir
              ? /内/.test(label ?? '')
                ? 'loop_inner'
                : 'loop_outer'
              : 'linear',
            direction_label: label,
            first_train: first ? [first] : [],
            last_train: last ? [last] : [],
            is_arrival: isSelf || undefined,
            service: 'all_days',
            extras: {
              dest_name: destName,
              line_short_name: short,
              source_line_name: row.lineName
            }
          });
        }
      }
    }
  }

  // Stations (operating physical nodes)
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
      names: { zh: phys.zh, en: phys.en || '' },
      location,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [
        ...(phys.officialCodes[0] ? [{ source: XA_SOURCE, id: phys.officialCodes[0] }] : []),
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : []),
        { source: XA_SOURCE, id: phys.zh }
      ],
      extras: {
        official_codes: phys.officialCodes,
        pinyin: phys.pinyin,
        is_interchange: phys.isInterchange,
        lines: [...phys.lineShorts],
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: 'amap_pinyin',
        fare_station_code: fareStationCode.get(phys.id)
      }
    });
  }

  // Fill official gaps by interpolating along the pattern so every station on a
  // publishing line owns times (verify coverage). Lines that stay sparse are
  // dropped entirely rather than shipped half-empty.
  {
    const fillTimetables = fillTimetableGaps(timetables, patterns, stops);
    timetables.length = 0;
    timetables.push(...fillTimetables);
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '西安地铁',
    names: { zh: '西安地铁', en: "Xi'an Metro" },
    city: placeholderCity('CN-6101'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑/站序/换乘标记来自西安地铁官网 pas-gateway-api findLineAll；首末班来自 aroundSite/getStationInfo 结构化字段（不解析时刻表图片）；坐标/线色/拼音英文名来自 AMap Subway 6101。官网未发布的线路首末班可用 OPENMETRO_BAIDU_AK 走百度规划器补齐（同 cn-nanjing，非 OCR）。西户线为市域铁路。'
  };

  return {
    network,
    lines: [...lineByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops: stops.sort((a, b) => a.id.localeCompare(b.id)),
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    transfers: [],
    timetables,
    officialLocations,
    fareStationCode
  };
}
