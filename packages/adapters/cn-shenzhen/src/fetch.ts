import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const SITE = 'https://www.szmc.net';
const STATIONS_JS = `${SITE}/styles/index/js/metroStationsList.js`;
const MAP_JSON = `${SITE}/styles/index/sz-subway/mcdata/shentie.json`;
const EN_TT_BASE = `${SITE}/szmc_en/Time_Table`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getText(url: string, referer = `${SITE}/`, retries = 5): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
        signal: AbortSignal.timeout(90_000)
      });
      if (res.status === 404) {
        throw Object.assign(new Error(`GET ${url} -> 404`), { fatal: true });
      }
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return await res.text();
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T = unknown>(url: string, referer = `${SITE}/`): Promise<T> {
  return JSON.parse(await getText(url, referer)) as T;
}

/** Official English timetable page paths keyed by line number / branch code. */
export const EN_TIMETABLE_PATHS: Record<string, string> = {
  '1': 'line1',
  '2': 'line2',
  '3': 'Line3',
  '4': 'Line4',
  '5': 'Line5',
  '6': 'Line6',
  '6支': 'line6zhi',
  '7': 'Line7',
  '8': 'Line8',
  '9': 'Line9',
  '10': 'Line10',
  '11': 'Line11',
  '12': 'Line12',
  '13': 'Line13',
  '14': 'Line14',
  '16': 'Line16',
  '20': 'Line20'
};

export interface ShMapStation {
  n: string;
  en?: string;
  sid?: string;
  si?: string;
  r?: string;
  t?: string;
  su?: string;
  p?: string;
  rs?: string;
  sl?: string;
  poiid?: string;
  sp?: string;
  lg?: string;
}

export interface ShMapLine {
  ln?: string;
  kn?: string;
  cl?: string;
  lo?: string;
  c?: string[] | string;
  lp?: string[] | string;
  ls?: string;
  li?: string;
  x?: number | string;
  su?: string;
  st?: ShMapStation[];
}

export interface ShMapDoc {
  s?: string;
  i?: string;
  l?: ShMapLine[];
}

export interface ShListStation {
  stationName: string;
  stationCode: string;
  stationQP?: string;
  stationJP?: string;
  includesLine?: { NO: string }[];
  facilitiesList?: { facilitiesName: string }[];
}

export interface ShListLine {
  line: string;
  lineName: string;
  starStation?: string;
  terminus?: string;
  stationList: ShListStation[];
}

export interface ShenzhenSources {
  mapDoc: ShMapDoc;
  listLines: ShListLine[];
  /** line number → English timetable HTML (missing pages are absent). */
  enTimetables: Record<string, string>;
}

/** Convert a JS object-array literal (comments, single quotes, bare keys) to JSON. */
function jsLiteralToJson(literal: string): string {
  let s = literal.replace(/\r\n/g, '\n');
  s = s.replace(/\/\/[^\n]*/g, '');
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  s = s.replace(/'((?:\\.|[^'\\])*)'/g, (_m, body: string) => JSON.stringify(body));
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

/** Parse `metroStationsList.js` into structured line cards. */
export function parseStationListJs(js: string): ShListLine[] {
  const start = js.indexOf('allLineList');
  if (start < 0) throw new Error('metroStationsList.js: allLineList not found');
  const eq = js.indexOf('=', start);
  const bracket = js.indexOf('[', eq);
  if (bracket < 0) throw new Error('metroStationsList.js: array not found');
  let depth = 0;
  let end = -1;
  for (let i = bracket; i < js.length; i++) {
    const ch = js[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('metroStationsList.js: unterminated array');
  return JSON.parse(jsLiteralToJson(js.slice(bracket, end))) as ShListLine[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function toHHMM(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = decodeEntities(raw).trim();
  if (!t || t === '--' || t === '—' || t === '-') return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return undefined;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Parse an English Time_Table HTML page into per-station first/last rows. */
export function parseEnTimetableHtml(html: string): {
  directions: [string, string];
  rows: {
    stationEn: string;
    dir0First?: string;
    dir0Last?: string;
    dir1First?: string;
    dir1Last?: string;
  }[];
} {
  const text = html.replace(/\r/g, '');
  const dirMatches = [...text.matchAll(/<strong>\s*To\s+([^<]+?)\s*<\/strong>/gi)];
  const dirs = dirMatches
    .map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((d) => d && !/^First Train$/i.test(d) && !/^Last Train$/i.test(d));
  const directions: [string, string] = [dirs[0] ?? '', dirs[1] ?? dirs[0] ?? ''];

  const rows: {
    stationEn: string;
    dir0First?: string;
    dir0Last?: string;
    dir1First?: string;
    dir1Last?: string;
  }[] = [];

  const tbody = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(text);
  const body = tbody?.[1] ?? text;
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  const cellText = (s: string) =>
    decodeEntities(s.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();

  while ((m = trRe.exec(body)) !== null) {
    const rowHtml = m[1];
    const cells = [...rowHtml.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) =>
      cellText(c[2])
    );
    if (cells.length < 2) continue;
    const stationEn = cells[0];
    if (
      !stationEn ||
      /^station$/i.test(stationEn) ||
      /^first train$/i.test(stationEn) ||
      /^last train$/i.test(stationEn) ||
      /^to\s+/i.test(stationEn)
    ) {
      continue;
    }
    const times = cells.slice(1);
    rows.push({
      stationEn,
      dir0First: toHHMM(times[0]),
      dir0Last: toHHMM(times[1]),
      dir1First: toHHMM(times[2]),
      dir1Last: toHHMM(times[3])
    });
  }
  return { directions, rows };
}

export interface MinTimeLeg {
  line?: string;
  lineName?: string;
  code?: string;
  departureStation?: string;
  arriveStation?: string;
  terminus?: string;
  nextStation?: string;
  passdepotname?: string;
  travelTime?: number | string;
  firstTime?: string;
  endTime?: string;
  transferTime?: number | string;
  transferDistance?: number | string;
  stationNO?: number | string;
  zhandianwanzhi?: string;
}

export interface MinTimeResponse {
  ticketPrice?: number | string;
  ticketPricesw?: number | string;
  adultSZT?: number | string;
  childSZT?: number | string;
  useTime?: number | string;
  times?: number | string;
  starStation?: string;
  terminus?: string;
  qidiancode?: string;
  zhondiancode?: string;
  lineList?: MinTimeLeg[];
  buslist?: {
    segmentlist?: {
      busid?: string;
      startname?: string;
      endname?: string;
      passdepotname?: string;
    }[];
  }[];
}

/**
 * Official path/fare planner. Station keys are official codes (`0101`) or
 * Chinese names. `ridingType=0` min-time, `1` min-transfer.
 */
export async function fetchMinTime(
  from: string,
  to: string,
  ridingType: 0 | 1 = 0,
  retries = 3
): Promise<MinTimeResponse | null> {
  const url = proxyUrl(
    `${SITE}/algorithm/Ticketing/MinTimeJson.do?departureStation=${encodeURIComponent(
      from
    )}&arriveStation=${encodeURIComponent(to)}&ridingType=${ridingType}`
  );
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({ Referer: `${SITE}/map/` }),
        signal: AbortSignal.timeout(45_000)
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`MinTime ${from}->${to} -> ${res.status}`);
      }
      const text = await res.text();
      if (!text.trim().startsWith('{')) return null;
      return JSON.parse(text) as MinTimeResponse;
    } catch (err) {
      lastErr = err;
      await sleep(300 * 2 ** attempt);
    }
  }
  void lastErr;
  return null;
}

export async function fetchShenzhenSources(
  opts: { skipEnTimetables?: boolean } = {}
): Promise<ShenzhenSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  console.log('  fetch metroStationsList.js');
  const listJs = await getText(STATIONS_JS, `${SITE}/`);
  console.log('  fetch shentie.json');
  const mapDoc = await getJson<ShMapDoc>(MAP_JSON, `${SITE}/map/`);
  const listLines = parseStationListJs(listJs);

  const enTimetables: Record<string, string> = {};
  if (!opts.skipEnTimetables) {
    const jobs = Object.entries(EN_TIMETABLE_PATHS);
    console.log(`  fetch English timetables (${jobs.length} lines)`);
    for (const [lineNo, path] of jobs) {
      try {
        const html = await getText(`${EN_TT_BASE}/${path}/`, `${SITE}/szmc_en/Time_Table/`);
        if (/First Train/i.test(html) && /<tbody/i.test(html)) {
          enTimetables[lineNo] = html;
        } else {
          console.log(`  EN timetable line ${lineNo}: no table`);
        }
      } catch (err) {
        console.log(
          `  EN timetable line ${lineNo}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await sleep(120);
    }
  }

  return { mapDoc, listLines, enTimetables };
}
