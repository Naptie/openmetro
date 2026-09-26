import {
  applyTimetableServiceStatus,
  asciiSlug,
  cleanTime,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  parsePixel,
  parseSlCoord,
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
import type {
  AmapLineRaw,
  AmapStationRaw,
  WhLineRow,
  WhMapLine,
  WhMapStation,
  WhSiteRow,
  WuhanSources
} from './fetch.js';

const NETWORK_ID = 'cn-wuhan';
const HELIOS_SOURCE = 'wuhanrt-helios';
const AMAP_SOURCE = 'amap-subway-4201';

/** Official display names when the wiring diagram uses short / legacy labels. */
const LINE_DISPLAY: Record<
  string,
  { zh: string; short: string; aliases: string[]; linecodes: string[] }
> = {
  '1号线': { zh: '1号线', short: '1', aliases: [], linecodes: ['01'] },
  '2号线': { zh: '2号线', short: '2', aliases: [], linecodes: ['02'] },
  '3号线': { zh: '3号线', short: '3', aliases: [], linecodes: ['03'] },
  '4号线': { zh: '4号线', short: '4', aliases: [], linecodes: ['04'] },
  '5号线': { zh: '5号线', short: '5', aliases: [], linecodes: ['05'] },
  '6号线': { zh: '6号线', short: '6', aliases: [], linecodes: ['06'] },
  '7号线': { zh: '7号线', short: '7', aliases: [], linecodes: ['07'] },
  '8号线': { zh: '8号线', short: '8', aliases: [], linecodes: ['08'] },
  '11号线': { zh: '11号线', short: '11', aliases: [], linecodes: ['11'] },
  '12号线': { zh: '12号线', short: '12', aliases: [], linecodes: ['12'] },
  '16号线': { zh: '16号线', short: '16', aliases: [], linecodes: ['16'] },
  '19号线': { zh: '19号线', short: '19', aliases: [], linecodes: ['19'] },
  阳逻线: {
    zh: '21号线（阳逻线）',
    short: '21',
    aliases: ['阳逻线', '21号线'],
    linecodes: ['21']
  },
  '21号线（阳逻线）': {
    zh: '21号线（阳逻线）',
    short: '21',
    aliases: ['阳逻线', '21号线'],
    linecodes: ['21']
  },
  '21号线(阳逻线)': {
    zh: '21号线（阳逻线）',
    short: '21',
    aliases: ['阳逻线', '21号线'],
    linecodes: ['21']
  }
};

export interface WuhanCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** fold(zh) → phys id, for planner times join. */
  stationIdByFold: Map<string, string>;
  /** phys id → zh name. */
  stationNameById: Map<string, string>;
  /** stop id → station zh. */
  stopName: Map<string, string>;
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



/** Official/AMap names may differ by a trailing 站 or full-width parens. */



function lineIdFromShort(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

function stopSlug(stopId: string): string {
  return stopId.replace(/^cn-wuhan-/, '');
}


function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract logical table rows as `cell | cell` lines, plus surrounding text lines. */
export function htmlToLogicalLines(html: string): string[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\r/g, '')
    .replace(/>\s+</g, '><');

  const out: string[] = [];
  const emitOutside = (chunk: string) => {
    const t = chunk
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    for (const raw of decodeEntities(t).split('\n')) {
      const s = raw.replace(/\s+/g, ' ').trim();
      if (s) out.push(s);
    }
  };

  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(cleaned))) {
    if (m.index > last) emitOutside(cleaned.slice(last, m.index));
    const table = m[0];
    const trRe = /<tr[\s\S]*?<\/tr>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = trRe.exec(table))) {
      const cells: string[] = [];
      const cellRe = /<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(tm[0]))) {
        cells.push(cellText(cm[0]));
      }
      const line = cells.filter((c) => c !== '').join(' | ');
      if (line.replace(/[|\s]/g, '').length > 0) out.push(line);
    }
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) emitOutside(cleaned.slice(last));
  return out.filter((l) => l.trim().length > 0);
}

/** Strip HTML to a pipe/newline table text. */
export function htmlToTableText(html: string): string {
  return htmlToLogicalLines(html).join('\n');
}

export interface TimetableDaySection {
  calendar: string;
  lineHint?: string;
  /** Direction header → raw cell rows. */
  directions: {
    header: string;
    origin?: string;
    terminal?: string;
    /** Multi last-train destination labels when present. */
    lastDests: string[];
    rows: {
      station: string;
      first?: string;
      lasts: (string | undefined)[];
    }[];
  }[];
}

function calendarFromHeading(h: string): string {
  if (/周一至周四|周一到周四/.test(h)) return 'mon_thu';
  if (/周五/.test(h)) return 'fri';
  if (/周六/.test(h)) return 'sat';
  if (/周日|周天/.test(h)) return 'sun';
  if (/节假日|法定/.test(h)) return 'holiday';
  if (/休息日|周末/.test(h)) return 'rest';
  if (/工作日|平日/.test(h)) return 'weekday';
  return 'weekday';
}

function parseDirectionHeader(header: string): {
  origin?: string;
  terminal?: string;
} {
  // 上行（汉口北-径河） / 上行（青龙山地铁小镇—黄陂广场） / 外环/上行（墨水湖公园-钢都花园）
  const m = /[（(]([^)）]+)[)）]/.exec(header);
  if (!m) return {};
  const inner = m[1]!.replace(/\s+/g, '');
  const parts = inner
    .split(/[-–—~～]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { origin: parts[0], terminal: parts[parts.length - 1] };
  return {};
}

/**
 * Parse a Wuhan timetable CMS article into day-type × direction tables.
 * Handles dual-column 上行/下行 layouts and extra last-train destination columns.
 */
export function parseTimetableArticle(html: string): TimetableDaySection[] {
  const lines = htmlToLogicalLines(html);

  const sections: TimetableDaySection[] = [];
  let current: TimetableDaySection | null = null;
  /** Active directions for the current dual-column table (1 or 2). */
  let activeDirs: TimetableDaySection['directions'] = [];
  /** How many last-train columns belong to the left half. */
  let leftLastCount = 1;
  /** How many last-train columns belong to the right half. */
  let rightLastCount = 1;

  const isHeading = (l: string) =>
    /各站首末班车时间|首末班车时间/.test(l) &&
    /(工作日|周一|周五|周六|周日|节假日|平日|休息日)/.test(l);

  const dirCells = (line: string) =>
    line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => /上行|下行|外环|内环/.test(c) && /[（(].*[)）]/.test(c));

  const lastDestsFromHeader = (headerLine: string): string[] => {
    const dests: string[] = [];
    const re = /终点站[:：]\s*([^)）|]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(headerLine))) {
      const d = m[1]!.trim();
      if (d) dests.push(d);
    }
    return dests;
  };

  const makeDir = (header: string): TimetableDaySection['directions'][number] => {
    const { origin, terminal } = parseDirectionHeader(header);
    return { header, origin, terminal, lastDests: [], rows: [] };
  };

  const isTimeLike = (c: string) =>
    /^\d{1,2}:\d{2}/.test(c) || /^[——\-–—]+$/.test(c) || /到达/.test(c) || c === '';

  const pushRow = (
    dir: TimetableDaySection['directions'][number],
    station: string,
    first: string | undefined,
    lasts: (string | undefined)[]
  ) => {
    if (!first && lasts.every((x) => !x)) return;
    if (/^(车站|首班车|末班车)/.test(station)) return;
    dir.rows.push({ station, first, lasts: lasts.length > 0 ? lasts : [undefined] });
  };

  for (const line of lines) {
    if (isHeading(line)) {
      const calendar = calendarFromHeading(line);
      if (!current || current.calendar !== calendar) {
        current = { calendar, directions: [] };
        sections.push(current);
      }
      activeDirs = [];
      continue;
    }
    if (!current) {
      current = { calendar: 'weekday', directions: [] };
      sections.push(current);
    }

    // Direction header row — may carry one or two headers on the same line,
    // or two consecutive single-header lines before the table body.
    const dCells = dirCells(line);
    if (dCells.length > 0 && /上行|下行|外环|内环/.test(line) && !/车站/.test(line)) {
      const noRowsYet = activeDirs.every((d) => d.rows.length === 0);
      if (dCells.length >= 2) {
        activeDirs = dCells.map((h) => makeDir(h));
      } else if (noRowsYet && activeDirs.length === 1 && activeDirs[0]!.header !== dCells[0]) {
        // Second direction header on its own line.
        activeDirs.push(makeDir(dCells[0]!));
      } else {
        activeDirs = dCells.map((h) => makeDir(h));
      }
      // Re-register current section directions (replace empty shells).
      current.directions = current.directions.filter((d) => d.rows.length > 0);
      for (const d of activeDirs) {
        if (!current.directions.includes(d)) current.directions.push(d);
      }
      leftLastCount = 1;
      rightLastCount = 1;
      continue;
    }

    if (activeDirs.length === 0) continue;

    // Table header row: split dual-column last-train destination labels.
    if (/车站/.test(line) && /首班车/.test(line)) {
      const dests = lastDestsFromHeader(line);
      const halves = line.split('|');
      // Find midpoint: second 车站 cell starts the right half.
      let rightStart = -1;
      let seenStation = 0;
      for (let i = 0; i < halves.length; i++) {
        if (/^车站$/.test(halves[i]!.trim())) {
          seenStation++;
          if (seenStation === 2) {
            rightStart = i;
            break;
          }
        }
      }
      if (activeDirs.length === 2 && rightStart > 0) {
        const leftHeader = halves.slice(0, rightStart).join('|');
        const rightHeader = halves.slice(rightStart).join('|');
        const leftDests = lastDestsFromHeader(leftHeader);
        const rightDests = lastDestsFromHeader(rightHeader);
        activeDirs[0]!.lastDests = leftDests;
        activeDirs[1]!.lastDests = rightDests;
        leftLastCount = Math.max(1, leftDests.length);
        rightLastCount = Math.max(1, rightDests.length);
      } else if (activeDirs.length === 1) {
        activeDirs[0]!.lastDests = dests;
        leftLastCount = Math.max(1, dests.length);
        rightLastCount = 1;
      }
      continue;
    }

    // Data row(s).
    const rawCells = line.split('|').map((c) => c.trim());
    if (rawCells.length < 2) continue;
    const station0 = rawCells[0] ?? '';
    if (/^(车站|首班车|末班车|上行|下行)/.test(station0) && !/\d/.test(line)) continue;
    if (/时间|备注|说明|温馨提示/.test(station0) && !/\d{1,2}:\d{2}/.test(line)) continue;

    if (activeDirs.length === 2) {
      // Dual-column: left half then right half, each station + times.
      // Detect the right-half start: first cell that looks like a station name
      // followed by a time (after we've already seen left times).
      // Layout A (simple): st | first | last | st | first | last
      // Layout B (multi last): st | first | last1 | last2 | st | first | last
      const leftWidth = 2 + leftLastCount; // station + first + lasts
      const rightWidth = 2 + rightLastCount;
      if (rawCells.length < leftWidth + 1) continue;

      const leftCells = rawCells.slice(0, leftWidth);
      const rightCells = rawCells.slice(leftWidth, leftWidth + rightWidth);
      // Right half may start later when left has fewer times (placeholders).
      // Fallback: if rightCells[0] looks like a time, shift left.
      if (rightCells.length > 0 && isTimeLike(rightCells[0]!) && rightCells[0] !== '') {
        // search for next station-like cell
        for (let split = leftWidth; split < rawCells.length; split++) {
          const c = rawCells[split] ?? '';
          if (c && !isTimeLike(c) && !/^\d{1,2}$/.test(c) && !/车站/.test(c)) {
            const lc = rawCells.slice(0, split);
            const rc = rawCells.slice(split, split + rightWidth);
            emitDual(activeDirs, lc, rc, leftLastCount, rightLastCount);
            break;
          }
        }
      } else {
        emitDual(activeDirs, leftCells, rightCells, leftLastCount, rightLastCount);
      }
    } else if (activeDirs.length === 1) {
      const dir = activeDirs[0]!;
      const times: string[] = [];
      for (let i = 1; i < rawCells.length; i++) {
        const c = rawCells[i]!;
        if (isTimeLike(c) && c !== '') times.push(c);
      }
      if (times.length === 0) continue;
      pushRow(dir, station0, cleanTime(times[0]), times.slice(1).map(cleanTime));
    }
  }

  function emitDual(
    dirs: TimetableDaySection['directions'],
    leftCells: string[],
    rightCells: string[],
    _leftLastCount: number,
    _rightLastCount: number
  ) {
    const parseSide = (cells: string[], dir: TimetableDaySection['directions'][number]) => {
      if (cells.length < 2) return;
      const station = cells[0] ?? '';
      if (!station || /^(车站|首班车|末班车)/.test(station)) return;
      const times: string[] = [];
      for (let i = 1; i < cells.length; i++) {
        const c = cells[i]!;
        if (isTimeLike(c) && c !== '') times.push(c);
        // stop when we hit another station name (safety)
        else if (c && !/^\d{1,2}$/.test(c) && times.length > 0) break;
      }
      if (times.length === 0) return;
      pushRow(dir, station, cleanTime(times[0]), times.slice(1).map(cleanTime));
    };
    parseSide(leftCells, dirs[0]!);
    if (dirs[1] && rightCells.length > 0) parseSide(rightCells, dirs[1]);
  }

  return sections.filter((s) => s.directions.some((d) => d.rows.length > 0));
}

interface Phys {
  id: string;
  zh: string;
  en: string;
  codes: string[];
  lineShorts: Set<string>;
  location?: { lon: number; lat: number };
  schematic?: { x: number; y: number };
  pinyin?: string;
  poiid?: string;
  description?: string;
  siteIds: string[];
  officialMapCoords?: { lon: number; lat: number };
}

function amapLinesByFold(amap: WuhanSources['amap']): Map<string, AmapLineRaw> {
  const by = new Map<string, AmapLineRaw>();
  for (const line of amap.l ?? []) {
    const kn = String(line.kn ?? '').trim();
    const ln = String(line.ln ?? '').trim();
    const key = normalizeLineKey(ln || kn);
    if (!key) continue;
    if (!by.has(key)) by.set(key, line);
  }
  return by;
}

function amapStationsByFold(amap: WuhanSources['amap']): Map<string, AmapStationRaw> {
  const byFold = new Map<string, AmapStationRaw>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

/** Map wiring/site line labels onto LINE_DISPLAY keys. */
export function normalizeLineKey(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (LINE_DISPLAY[t]) return LINE_DISPLAY[t]!.zh;
  // 轨道交通N号线 / 轨道交通21号线(阳逻线)
  const stripped = t.replace(/^轨道交通/, '').trim();
  if (LINE_DISPLAY[stripped]) return LINE_DISPLAY[stripped]!.zh;
  const yangluo = /阳逻|21号线/.test(stripped);
  if (yangluo) return '21号线（阳逻线）';
  const numbered = /^(\d+)号线/.exec(stripped);
  if (numbered && LINE_DISPLAY[`${numbered[1]}号线`]) {
    return LINE_DISPLAY[`${numbered[1]}号线`]!.zh;
  }
  return stripped;
}

function lineMetaFor(key: string): { zh: string; short: string; aliases: string[] } {
  const meta = LINE_DISPLAY[key];
  if (meta) return { zh: meta.zh, short: meta.short, aliases: meta.aliases };
  const short = resolveLineShortName(key);
  return { zh: key, short, aliases: [] };
}

function isVirtualMapLine(line: WhMapLine): boolean {
  const kn = String(line.kn ?? '');
  const ln = String(line.ln ?? '');
  return /虚拟/.test(kn) || /虚拟/.test(ln) || (line.st ?? []).length === 0;
}

export function normalizeWuhan(input: WuhanSources): WuhanCanonical {
  const amapLineByKey = amapLinesByFold(input.amap);
  const amapStationByFold = amapStationsByFold(input.amap);

  // ---- Lines ----------------------------------------------------------------
  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();
  const lineShortByKey = new Map<string, string>();
  const amapEnByShort = new Map<string, string>();
  const officialColorByKey = new Map<string, string>();

  for (const row of input.lines as WhLineRow[]) {
    const key = normalizeLineKey(row.lineName);
    if (!key) continue;
    officialColorByKey.set(key, row.lineColor ?? officialColorByKey.get(key) ?? '');
  }

  const wiringLines = (input.wiring.l ?? []).filter((l) => !isVirtualMapLine(l));
  for (const line of wiringLines) {
    const key = normalizeLineKey(String(line.ln ?? line.kn ?? ''));
    if (!key) continue;
    if (!officialColorByKey.has(key) && line.cl) officialColorByKey.set(key, `#${line.cl}`);
  }

  const ensureLine = (key: string): { id: string; short: string; zh: string } => {
    const meta = lineMetaFor(key);
    const short = meta.short;
    lineShortByKey.set(key, short);
    const existingId = lineIdByShort.get(short);
    if (existingId && lineRecordByShort.has(short)) {
      return { id: existingId, short, zh: lineRecordByShort.get(short)!.name };
    }
    const lineId = existingId ?? lineIdFromShort(short);
    lineIdByShort.set(short, lineId);

    const amap = amapLineByKey.get(key) ?? amapLineByKey.get(meta.zh);
    const colorRaw =
      officialColorByKey.get(key) ??
      officialColorByKey.get(meta.zh) ??
      (amap?.cl ? `#${amap.cl}` : undefined);
    const color = hexToCss(colorRaw);
    const enFromAmap = String(amap?.el ?? '').trim();
    const nameEn =
      enFromAmap ||
      deriveLineEnglishName(meta.zh) ||
      (short === '21' ? 'Line 21 / Yangluo Line' : `Line ${short}`);
    amapEnByShort.set(short, nameEn);

    const aliases = [
      ...new Set(
        [...meta.aliases, key !== meta.zh ? key : '', String(amap?.kn ?? '')].filter(
          (a) => a && a !== meta.zh && !/^轨道交通/.test(a)
        )
      )
    ];

    lineRecordByShort.set(short, {
      id: lineId,
      name: meta.zh,
      names: { zh: meta.zh, en: nameEn },
      aliases,
      color,
      short_name: short,
      mode: 'metro',
      status: 'operating',
      loop: false,
      source_ids: [
        { source: HELIOS_SOURCE, id: key },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: enFromAmap ? 'source' : 'derived',
        official_line_color: colorRaw,
        amap_color: amap?.cl,
        route_linecodes: LINE_DISPLAY[key]?.linecodes ?? [],
        line_info: (input.lines as WhLineRow[]).find((r) => normalizeLineKey(r.lineName) === key)
          ?.lineInfo
      }
    });
    return { id: lineId, short, zh: meta.zh };
  };

  // Seed from official line list + wiring diagram.
  for (const row of input.lines as WhLineRow[]) {
    const key = normalizeLineKey(row.lineName);
    if (key) ensureLine(key);
  }
  for (const line of wiringLines) {
    const key = normalizeLineKey(String(line.ln ?? line.kn ?? ''));
    if (key) ensureLine(key);
  }

  // ---- Sites / physical stations --------------------------------------------
  const physByFold = new Map<string, Phys>();
  const siteRows = input.sites as WhSiteRow[];

  const ensurePhys = (zhRaw: string): Phys | undefined => {
    const zh = zhRaw.trim();
    if (!zh) return undefined;
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    if (phys) return phys;
    const amap = amapStationByFold.get(key);
    const pinyin = String(amap?.sp ?? '').trim() || undefined;
    const enRaw = String(amap?.multilang?.n?.en ?? amap?.en ?? '').trim() || undefined;
    const en = resolveEnglishName(enRaw, pinyin, zh);
    const loc = parseSlCoord(amap?.sl);
    const pix = parsePixel(amap?.p);
    phys = {
      id: `${NETWORK_ID}-${stationIdFor(en, zh)}`,
      zh,
      en,
      codes: [],
      lineShorts: new Set(),
      location: loc,
      schematic: pix,
      pinyin,
      poiid: amap?.poiid || undefined,
      siteIds: []
    };
    physByFold.set(key, phys);
    return phys;
  };

  for (const site of siteRows) {
    const phys = ensurePhys(site.siteName);
    if (!phys) continue;
    const key = normalizeLineKey(site.lineName);
    if (key) phys.lineShorts.add(lineMetaFor(key).short);
    if (site.id) phys.siteIds.push(site.id);
    if (site.siteInfo) phys.description = site.siteInfo;
  }

  // ---- Stops / patterns / segments from wiring diagram ----------------------
  type StopBuild = {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    is_terminal: boolean;
    source_id?: string;
    schematic?: { x: number; y: number; crs: 'schematic' };
    extras: Record<string, unknown>;
  };
  const stopById = new Map<string, StopBuild>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeySet = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensureStop = (
    phys: Phys,
    lineId: string,
    short: string,
    seq: number,
    mapStation?: WhMapStation
  ): StopBuild => {
    const id = stopIdOf(phys.id, short);
    const existing = stopById.get(id);
    if (existing) return existing;
    const code = mapStation?.si || mapStation?.sid || phys.codes[0];
    if (code && !phys.codes.includes(code)) phys.codes.push(code);
    const pix = parsePixel(mapStation?.p) ?? phys.schematic;
    const stop: StopBuild = {
      id,
      station_id: phys.id,
      line_id: lineId,
      sequence: seq,
      is_terminal: false,
      source_id: code,
      schematic: pix ? { x: pix.x, y: pix.y, crs: 'schematic' as const } : undefined,
      extras: {
        line_short_name: short,
        station_code: code,
        official_site_ids: phys.siteIds
      }
    };
    stopById.set(id, stop);
    return stop;
  };

  type PatternBuild = {
    patternId: string;
    lineId: string;
    short: string;
    stopIds: string[];
    stationIds: string[];
    originZh: string;
    terminalZh: string;
  };
  const patternBuilds: PatternBuild[] = [];

  for (const mapLine of wiringLines) {
    const key = normalizeLineKey(String(mapLine.ln ?? mapLine.kn ?? ''));
    if (!key) continue;
    const { id: lineId, short } = ensureLine(key);
    const stations = (mapLine.st ?? []).filter((s) => String(s.n ?? '').trim());
    if (stations.length < 2) continue;

    const physList: Phys[] = [];
    for (const st of stations) {
      const phys = ensurePhys(String(st.n));
      if (!phys) continue;
      phys.lineShorts.add(short);
      const mapLoc = parseSlCoord(st.sl);
      if (mapLoc) phys.officialMapCoords = mapLoc;
      // Prefer AMap location; record official map as fallback.
      if (!phys.location && mapLoc) phys.location = mapLoc;
      if (st.si && !phys.codes.includes(st.si)) phys.codes.push(st.si);
      if (st.poiid && !phys.poiid) phys.poiid = st.poiid;
      if (st.sp && !phys.pinyin) phys.pinyin = st.sp;
      physList.push(phys);
    }
    if (physList.length < 2) continue;

    const seqDirs = [
      {
        title: `往${physList[physList.length - 1]!.zh}方向`,
        list: physList,
        mapStations: stations
      },
      {
        title: `往${physList[0]!.zh}方向`,
        list: [...physList].reverse(),
        mapStations: [...stations].reverse(),
        reverse: true
      }
    ];

    let primaryTaken = false;
    const seenSig = new Set<string>();
    const patternIdBySig = new Map<string, string>();

    for (const dir of seqDirs) {
      const stopIds: string[] = [];
      const stationIds: string[] = [];
      for (let i = 0; i < dir.list.length; i++) {
        const phys = dir.list[i]!;
        const mapSt = dir.mapStations[i];
        const stop = ensureStop(phys, lineId, short, i, mapSt);
        stopIds.push(stop.id);
        stationIds.push(phys.id);
      }
      stopById.get(stopIds[0]!)!.is_terminal = true;
      stopById.get(stopIds[stopIds.length - 1]!)!.is_terminal = true;

      const sig = stopIds.join('|');
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      const revSig = [...stopIds].reverse().join('|');
      const reverseOfId = patternIdBySig.get(revSig);
      const isPrimary = !primaryTaken && !reverseOfId;
      if (isPrimary) primaryTaken = true;

      const originZh = dir.list[0]!.zh;
      const terminalZh = dir.list[dir.list.length - 1]!.zh;
      const patternId = `${lineId}-pattern-${stopSlug(stopIds[0]!)}-to-${stopSlug(
        stopIds[stopIds.length - 1]!
      )}`;
      patternIdBySig.set(sig, patternId);
      const lineRec = lineRecordByShort.get(short)!;
      patterns.push({
        id: patternId,
        line_id: lineId,
        name: lineRec.name,
        names: { zh: lineRec.names.zh, en: lineRec.names.en },
        stop_ids: stopIds,
        origin_stop_id: stopIds[0]!,
        terminal_stop_id: stopIds[stopIds.length - 1]!,
        is_primary: isPrimary,
        source_ids: [{ source: HELIOS_SOURCE, id: String(mapLine.kn ?? key) }],
        extras: {
          direction_title: dir.title,
          origin_name: originZh,
          terminal_name: terminalZh,
          line_short_name: short,
          pattern_role: reverseOfId ? 'reverse' : 'direction',
          reverse_of: reverseOfId
        }
      });
      patternBuilds.push({
        patternId,
        lineId,
        short,
        stopIds,
        stationIds,
        originZh,
        terminalZh
      });

      for (let i = 0; i < stopIds.length - 1; i++) {
        const aStop = stopIds[i]!;
        const bStop = stopIds[i + 1]!;
        const keySeg = [lineId, aStop, bStop].sort().join('|');
        if (segmentKeySet.has(keySeg)) continue;
        segmentKeySet.add(keySeg);
        segments.push({
          id: `${NETWORK_ID}-seg-${aStop}-${bStop}`,
          line_id: lineId,
          from_stop_id: aStop,
          to_stop_id: bStop,
          from_station_id: stationIds[i]!,
          to_station_id: stationIds[i + 1]!,
          direction: 'both',
          source_id: HELIOS_SOURCE
        });
      }
    }

    // One primary per line = longest alignment.
    const linePats = patterns.map((p, i) => ({ p, i })).filter(({ p }) => p.line_id === lineId);
    if (linePats.length > 0) {
      const winner = [...linePats].sort((a, b) => b.p.stop_ids.length - a.p.stop_ids.length)[0]!;
      for (const { p, i } of linePats) {
        patterns[i] = { ...p, is_primary: p.id === winner.p.id };
      }
    }
  }

  // Unique stop.sequence per line via primary then others.
  {
    const assigned = new Set<string>();
    const ordered = [...patterns].sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return b.stop_ids.length - a.stop_ids.length;
    });
    const lineNext = new Map<string, number>();
    for (const p of ordered) {
      let next = lineNext.get(p.line_id) ?? 0;
      for (const stopId of p.stop_ids) {
        const stop = stopById.get(stopId);
        if (!stop || assigned.has(stop.id)) continue;
        stop.sequence = next++;
        assigned.add(stop.id);
      }
      lineNext.set(p.line_id, next);
    }
  }

  // ---- Timetables from CMS articles ----------------------------------------
  const stationIdByFold = new Map<string, string>();
  const stationNameById = new Map<string, string>();
  for (const phys of physByFold.values()) {
    stationIdByFold.set(foldStationName(phys.zh), phys.id);
    stationNameById.set(phys.id, phys.zh);
  }

  const findPatternFor = (
    short: string,
    originZh?: string,
    terminalZh?: string
  ): PatternEncoded | undefined => {
    const linePats = patterns.filter((p) => p.line_id === lineIdByShort.get(short));
    if (!linePats.length) return undefined;
    if (originZh || terminalZh) {
      const o = originZh ? foldStationName(originZh) : undefined;
      const t = terminalZh ? foldStationName(terminalZh) : undefined;
      const exact = linePats.find((p) => {
        const origin = stationNameById.get(stopById.get(p.origin_stop_id!)?.station_id ?? '');
        const term = stationNameById.get(stopById.get(p.terminal_stop_id!)?.station_id ?? '');
        return (
          (!o || foldStationName(origin ?? '') === o) && (!t || foldStationName(term ?? '') === t)
        );
      });
      if (exact) return exact;
    }
    return linePats.find((p) => p.is_primary) ?? linePats[0];
  };

  type RawTt = {
    stationId: string;
    stopId: string;
    lineId: string;
    short: string;
    stationCode?: string;
    destStopId: string;
    destName?: string;
    originStopId: string;
    patternId: string;
    directionLabel: string;
    originZh?: string;
    terminalZh?: string;
    calendar: string;
    first?: string;
    last?: string;
    articleId: unknown;
    articleTitle?: string;
    multiDest?: boolean;
  };
  const rawTts: RawTt[] = [];

  const stopIdForName = (zh: string, short: string): string | undefined => {
    for (const [sid, name] of stationNameById) {
      if (foldStationName(name) === foldStationName(zh)) {
        const id = stopIdOf(sid, short);
        if (stopById.has(id)) return id;
      }
    }
    return undefined;
  };

  for (const [lineKey, article] of Object.entries(input.timetableArticles)) {
    const key = normalizeLineKey(lineKey);
    const short = lineMetaFor(key).short;
    const lineId = lineIdByShort.get(short);
    if (!lineId) continue;
    const sections = parseTimetableArticle(article.content ?? '');
    const articleId = article.id;

    for (const section of sections) {
      for (const dir of section.directions) {
        const pattern = findPatternFor(short, dir.origin, dir.terminal);
        if (!pattern) continue;
        const originStopId = pattern.origin_stop_id!;
        let destStopId = pattern.terminal_stop_id!;
        if (dir.terminal) {
          destStopId = stopIdForName(dir.terminal, short) ?? destStopId;
        }
        const destStationId = stopById.get(destStopId)?.station_id;
        const destName = destStationId ? stationNameById.get(destStationId) : undefined;

        for (const row of dir.rows) {
          const phys = physByFold.get(foldStationName(row.station));
          if (!phys) continue;
          if (!phys.lineShorts.has(short)) phys.lineShorts.add(short);
          const stopId = stopIdOf(phys.id, short);
          if (!stopById.has(stopId)) continue;
          const first = row.first;
          const multi = dir.lastDests.length > 1 && row.lasts.length > 1;

          const push = (
            lastTime: string | undefined,
            destLabel: string | undefined,
            dStop: string
          ) => {
            if (!first && !lastTime) return;
            rawTts.push({
              stationId: phys.id,
              stopId,
              lineId,
              short,
              stationCode: phys.codes[0],
              destStopId: dStop,
              destName: destLabel ?? destName,
              originStopId,
              patternId: pattern.id,
              directionLabel: dir.header,
              originZh: dir.origin,
              terminalZh: dir.terminal,
              calendar: section.calendar,
              first,
              last: lastTime,
              articleId,
              articleTitle: article.title,
              multiDest: multi || undefined
            });
          };

          if (multi) {
            for (let i = 0; i < dir.lastDests.length && i < row.lasts.length; i++) {
              const label = dir.lastDests[i]!;
              const dStop = stopIdForName(label, short) ?? destStopId;
              push(row.lasts[i], label, dStop);
            }
          } else {
            push(row.lasts[0], destName, destStopId);
          }
        }
      }
    }
  }

  /** Calendar → Monday-first day indices (0=Mon … 6=Sun). */
  const calendarDays = (cal: string): number[] => {
    switch (cal) {
      case 'mon_thu':
        return [0, 1, 2, 3];
      case 'fri':
        return [4];
      case 'sat':
        return [5];
      case 'sun':
        return [6];
      case 'rest':
        return [5, 6];
      case 'holiday':
        return [];
      default:
        return [0, 1, 2, 3, 4];
    }
  };

  type MergedTt = {
    stationId: string;
    stopId: string;
    lineId: string;
    short: string;
    stationCode?: string;
    destStopId: string;
    destName?: string;
    originStopId: string;
    patternId: string;
    directionLabel: string;
    originZh?: string;
    terminalZh?: string;
    firstDays: (string | undefined)[];
    lastDays: (string | undefined)[];
    firstSeen: string | undefined;
    lastSeen: string | undefined;
    calendars: Set<string>;
    articleId: unknown;
    articleTitle?: string;
    multiDest?: boolean;
  };
  const merged = new Map<string, MergedTt>();
  for (const r of rawTts) {
    const mkey = [r.stationId, r.lineId, r.destStopId, r.patternId, r.directionLabel].join('|');
    let m = merged.get(mkey);
    if (!m) {
      m = {
        ...r,
        firstDays: new Array(7).fill(undefined),
        lastDays: new Array(7).fill(undefined),
        firstSeen: undefined,
        lastSeen: undefined,
        calendars: new Set()
      };
      merged.set(mkey, m);
    }
    m.calendars.add(r.calendar);
    if (r.first) m.firstSeen = r.first;
    if (r.last) m.lastSeen = r.last;
    for (const d of calendarDays(r.calendar)) {
      if (r.first) m.firstDays[d] = r.first;
      if (r.last) m.lastDays[d] = r.last;
    }
  }

  for (const m of merged.values()) {
    // Backfill missing days from the most common / first seen value.
    const firstFallback = m.firstDays.find((x) => x) ?? m.firstSeen;
    const lastFallback = m.lastDays.find((x) => x) ?? m.lastSeen;
    const filledFirst = m.firstDays.map((x) => x ?? firstFallback);
    const filledLast = m.lastDays.map((x) => x ?? lastFallback);
    const uniqFirst = [...new Set(filledFirst.filter(Boolean))];
    const uniqLast = [...new Set(filledLast.filter(Boolean))];
    const sameAll = uniqFirst.length <= 1 && uniqLast.length <= 1;
    const first_train = sameAll
      ? uniqFirst[0]
        ? [uniqFirst[0]]
        : []
      : filledFirst.map((x) => x ?? '');
    const last_train = sameAll
      ? uniqLast[0]
        ? [uniqLast[0]]
        : []
      : filledLast.map((x) => x ?? '');
    // Schema requires HH:MM strings; empty slots only allowed if we still have length 7 with values.
    if (!sameAll) {
      if (first_train.some((t) => !t) || last_train.some((t) => !t)) {
        // Fall back to single representative times rather than invalid arrays.
        if (!firstFallback && !lastFallback) continue;
        first_train.length = 0;
        last_train.length = 0;
        if (firstFallback) first_train.push(firstFallback);
        if (lastFallback) last_train.push(lastFallback);
      }
    }
    if (first_train.length === 0 && last_train.length === 0) continue;
    const id = `${NETWORK_ID}-${m.stationId}-${m.short}-to-${asciiSlug(m.destStopId)}-${asciiSlug(
      m.directionLabel
    )}`;
    if (ttIds.has(id)) continue;
    ttIds.add(id);
    timetables.push({
      id,
      station_id: m.stationId,
      stop_id: m.stopId,
      line_id: m.lineId,
      station_code: m.stationCode,
      source_id: HELIOS_SOURCE,
      destination_stop_id: m.destStopId,
      origin_stop_id: m.originStopId,
      pattern_id: m.patternId,
      direction_type: 'linear',
      direction_label: m.directionLabel,
      first_train,
      last_train,
      service: 'all_days',
      extras: {
        calendars: [...m.calendars],
        source_article_id: m.articleId,
        source_title: m.articleTitle,
        dest_name: m.destName,
        line_short_name: m.short,
        direction_origin: m.originZh,
        direction_terminal: m.terminalZh,
        multi_dest: m.multiDest || undefined
      }
    });
  }

  // ---- Station + stop records ----------------------------------------------
  const usedStationIds = new Set([...stopById.values()].map((s) => s.station_id));
  const stationsById = new Map<string, Phys>();
  for (const phys of physByFold.values()) {
    if (!usedStationIds.has(phys.id)) continue;
    if (!stationsById.has(phys.id)) stationsById.set(phys.id, phys);
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));

  let stations: StationEncoded[] = [];
  for (const phys of stationsById.values()) {
    const location =
      phys.location != null
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
        ...phys.siteIds.map((id) => ({ source: HELIOS_SOURCE, id })),
        ...(phys.codes.length ? phys.codes.map((c) => ({ source: HELIOS_SOURCE, id: c })) : []),
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : []),
        { source: HELIOS_SOURCE, id: phys.zh }
      ],
      extras: {
        official_codes: phys.codes,
        pinyin: phys.pinyin,
        description: phys.description,
        lines: [...phys.lineShorts],
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived',
        virtual_transfer_pairs: ['武汉东站', '复兴路-紫阳湖', '武昌火车站']
      }
    });
  }

  stations = applyTimetableServiceStatus(
    stations,
    [...stopById.values()].map((s) => ({
      id: s.id,
      station_id: s.station_id,
      line_id: s.line_id,
      sequence: s.sequence,
      is_terminal: s.is_terminal,
      source_id: s.source_id,
      schematic: s.schematic,
      extras: s.extras
    })),
    filteredTimetables
  );

  const stops: StopEncoded[] = [...stopById.values()]
    .map((s) => ({
      id: s.id,
      station_id: s.station_id,
      line_id: s.line_id,
      sequence: s.sequence,
      is_terminal: s.is_terminal,
      source_id: s.source_id,
      schematic: s.schematic,
      extras: s.extras
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const stopName = new Map<string, string>();
  for (const s of stops) {
    const zh = stationNameById.get(s.station_id);
    if (zh) stopName.set(s.id, zh);
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '武汉地铁',
    names: { zh: '武汉地铁', en: 'Wuhan Metro' },
    city: {
      id: 'CN-4201',
      name: { zh: '武汉', en: 'Wuhan' },
      country: 'CN',
      population: 13739000,
      area: 8569,
      location: { type: 'Point', coordinates: [114.3055, 30.5928] }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与官方站码来自武汉地铁官网 helios 接线图/站点接口；首末班来自官网运营时刻表栏目文章（工作日为主，2号线含分日型）；坐标与英文名来自官网线网图所用 AMap Subway 数据。12号线由武汉轨道交通十二号线建设运营有限公司运营。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    transfers: [],
    timetables: filteredTimetables,
    officialLocations,
    stationIdByFold,
    stationNameById,
    stopName
  };
}
