import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const SITE = 'https://www.cqmetro.cn';
export const STATIONS_JS = `${SITE}/xcgh/script.js`;
export const STATION_COORDS_JS = `${SITE}/xcgh/station.js`;
export const TIMETABLE_JSON = `${SITE}/smbsj/json/data.json`;
export const FARE_ACTION = `${SITE}/Front/html/TakeLine!queryYsTakeLine.action`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/5000_drw_chongqing.json';

/** Official line configs from `/smbsj/` + `/yyt/script.js`. */
export interface CqLineConfig {
  name: string;
  lineSid: number;
  color: string;
  shortName: string;
  /** suburban_rail for 江跳线 / 璧铜线 */
  mode: 'metro' | 'suburban_rail' | 'monorail';
  loop?: boolean;
}

export const LINE_CONFIGS: CqLineConfig[] = [
  { name: '环线', lineSid: 1001, color: '#f6a800', shortName: '环', mode: 'metro', loop: true },
  { name: '1号线', lineSid: 1002, color: '#cc3333', shortName: '1', mode: 'metro' },
  { name: '2号线', lineSid: 1003, color: '#008337', shortName: '2', mode: 'monorail' },
  { name: '3号线', lineSid: 1004, color: '#06287f', shortName: '3', mode: 'monorail' },
  { name: '4号线', lineSid: 1005, color: '#ed8e00', shortName: '4', mode: 'metro' },
  { name: '5号线', lineSid: 1006, color: '#0098db', shortName: '5', mode: 'metro' },
  { name: '6号线', lineSid: 1007, color: '#eb6183', shortName: '6', mode: 'metro' },
  { name: '国博线', lineSid: 1008, color: '#eb6183', shortName: '国博', mode: 'metro' },
  { name: '10号线', lineSid: 1009, color: '#5a2a8d', shortName: '10', mode: 'metro' },
  { name: '9号线', lineSid: 10003, color: '#8d2342', shortName: '9', mode: 'metro' },
  {
    name: '江跳线',
    lineSid: 10004,
    color: '#0056b8',
    shortName: '江跳',
    mode: 'suburban_rail'
  },
  { name: '18号线', lineSid: 10005, color: '#37d5ca', shortName: '18', mode: 'metro' },
  {
    name: '璧铜线',
    lineSid: 10006,
    color: '#0056b8',
    shortName: '璧铜',
    mode: 'suburban_rail'
  }
];

export interface CqTimetableCell {
  text: string;
  rowspan: number;
  colspan: number;
}

export interface CqTimetableRow {
  isBz?: number;
  bzContent?: string;
  [col: string]: CqTimetableRow[keyof CqTimetableRow] | undefined;
}

export interface CqTimetableLine {
  lineSid: number;
  lineName: string;
  scheduls: Record<string, unknown>[];
}

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  sl?: string;
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  multilang?: { n?: { en?: string } };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  cl?: string;
  la?: string;
  el?: string;
  ek?: string;
  ls?: string;
  li?: string;
  c?: string | string[];
  st?: AmapStation[];
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface CqFareResult {
  startStaName?: string;
  endStaName?: string;
  price?: number | string;
  needTimeScope?: number | string;
  needTransferTimes?: number | string;
  transferLines?: string;
  transferStaNames?: string;
}

export interface CqFareResponse {
  success?: boolean;
  msg?: string;
  result?: CqFareResult[];
}

export interface ChongqingSources {
  stationsJs: string;
  stationCoordsJs: string;
  timetables: CqTimetableLine[];
  amap: AmapSubwayDoc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer = `${SITE}/`, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer = `${SITE}/`): Promise<T> {
  return JSON.parse(await getText(url, referer)) as T;
}

/**
 * Official first/last tables (`/smbsj/json/data.json`) are HTML-table cells
 * serialized as `"text(rowspan,colspan)"`.
 */
export function parseCell(val: unknown): CqTimetableCell | null {
  if (typeof val !== 'string' || !val) return null;
  const m = val.match(/^(.+)\((\d+),(\d+)\)$/);
  if (m) {
    return { text: m[1], rowspan: Number(m[2]), colspan: Number(m[3]) };
  }
  return { text: val, rowspan: 1, colspan: 1 };
}

export function parseStationsByLine(js: string): Record<string, string[]> {
  const start = js.indexOf('const stationsByLine');
  if (start < 0) throw new Error('stationsByLine not found in xcgh/script.js');
  const brace = js.indexOf('{', start);
  // Walk to matching close of the object literal.
  let depth = 0;
  let end = -1;
  for (let i = brace; i < js.length; i++) {
    const ch = js[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('unbalanced stationsByLine literal');
  const body = js.slice(brace, end + 1);
  // Eval as JS object literal (string keys + array of string literals).
  const obj = new Function(`return (${body});`)() as Record<string, string[]>;
  return obj;
}

export function parseStationsCoords(js: string): Record<string, Record<string, [number, number]>> {
  const start = js.indexOf('var stationsCoords');
  if (start < 0) throw new Error('stationsCoords not found in xcgh/station.js');
  const brace = js.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < js.length; i++) {
    const ch = js[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('unbalanced stationsCoords literal');
  const body = js.slice(brace, end + 1);
  const obj = new Function(`return (${body});`)() as Record<
    string,
    Record<string, [number, number]>
  >;
  return obj;
}

export async function fetchChongqingSources(): Promise<ChongqingSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  console.log('  fetch cqmetro xcgh/station.js + script.js');
  const stationCoordsJs = await getText(STATION_COORDS_JS);
  const stationsJs = await getText(STATIONS_JS);
  console.log('  fetch cqmetro smbsj/json/data.json');
  const timetables = await getJson<CqTimetableLine[]>(TIMETABLE_JSON);
  console.log('  fetch AMap subway 5000_drw_chongqing.json');
  const amap = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, 'https://map.amap.com/');
  return { stationsJs, stationCoordsJs, timetables, amap };
}

/** Official OD fare from `TakeLine!queryYsTakeLine.action`. */
export async function fetchChongqingFare(
  startName: string,
  endName: string
): Promise<CqFareResponse | null> {
  try {
    const qs = new URLSearchParams({
      'entity.startStaName': startName,
      'entity.endStaName': endName
    });
    const res = await fetch(proxyUrl(`${FARE_ACTION}?${qs.toString()}`), {
      headers: officialFetchHeaders({
        Referer: `${SITE}/xcgh/`,
        Accept: 'application/json, text/plain, */*'
      }),
      signal: AbortSignal.timeout(40_000)
    });
    if (!res.ok) return null;
    return (await res.json()) as CqFareResponse;
  } catch {
    return null;
  }
}
