import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const SITE = 'https://www.zzmetro.com';
const API = 'https://api.zzmetro.com';
const STATIONS_API = `${API}/api/stations`;
const LINES_API = `${API}/api/lines`;
const PRICE_API = `${API}/api/price`;
const OPERATING_HOURS = `${SITE}/lines/query/operating_hours`;
const STATION_PAGE = `${SITE}/lines/query/station`;
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/4101_drw_zhengzhou.json';

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

export interface ZzApiEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

/** `/api/stations?with=lines` payload. */
export interface ZzStationsData {
  lines: Record<string, string>;
  /** lineId → { zid: stationName } */
  stations: Record<string, Record<string, string>>;
}

export interface ZzPricePlanLine {
  id: number | string;
  name?: string;
  status?: number;
  length?: string | number;
  color?: string;
  first_up_time?: string;
  first_down_time?: string;
  last_up_time?: string;
  last_down_time?: string;
  total?: number;
  start_station?: string;
  end_station?: string;
}

export interface ZzPriceStation {
  id?: number;
  zid: number | string;
  name: string;
  line?: string;
  run?: boolean;
  status?: boolean;
  position?: [string, string] | string[];
}

export interface ZzPricePlan {
  line: ZzPricePlanLine;
  stations: ZzPriceStation[];
  direction?: string;
}

export interface ZzPriceData {
  time?: number | string;
  price?: number | string;
  price2?: number | string;
  distance?: number | string;
  path?: string;
  zid?: (number | string)[];
  plans?: ZzPricePlan[];
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
  multilang?: { n?: { en?: string; [k: string]: string | undefined } };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  cl?: string;
  lo?: number | string;
  st?: AmapStation[];
  c?: string | string[];
  li?: string;
  el?: string;
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface ZhengzhouSources {
  /** Official line id → Chinese name. */
  lines: Record<string, string>;
  /** Official line id → { zid: stationName }. */
  stations: Record<string, Record<string, string>>;
  /** `operating_hours` SSR HTML (all lines, today's first/last trains). */
  operatingHoursHtml: string;
  /** `station` SSR HTML (sequences + per-station detail tabs). */
  stationPageHtml: string;
  amap: AmapSubwayDoc;
}

export async function fetchZzStations(): Promise<ZzStationsData> {
  const plain = await getJson<ZzApiEnvelope<ZzStationsData>>(`${STATIONS_API}?with=lines`);
  const data = plain.data;
  if (!data?.stations || !data.lines) {
    throw new Error(`zzmetro /api/stations failed: ${plain.message || 'empty'}`);
  }
  return { lines: data.lines, stations: data.stations };
}

export async function fetchZzLines(): Promise<Record<string, string>> {
  const env = await getJson<ZzApiEnvelope<Record<string, string>>>(LINES_API);
  return env.data ?? {};
}

export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const text = await getText(AMAP_SUBWAY, `${SITE}/`);
  return JSON.parse(text) as AmapSubwayDoc;
}

export async function fetchOperatingHours(date?: string): Promise<string> {
  const url = date ? `${OPERATING_HOURS}?date=${encodeURIComponent(date)}` : OPERATING_HOURS;
  return getText(url);
}

export async function fetchStationPage(): Promise<string> {
  return getText(STATION_PAGE);
}

/**
 * Official trip planner: fare, OD distance/time (seconds), path legs.
 * `type` is `distance` (距离最短) or `transfer` (换乘最少).
 */
export async function fetchPrice(
  beginZid: string,
  endZid: string,
  type: 'distance' | 'transfer' = 'distance',
  retries = 3
): Promise<ZzPriceData | null> {
  const url = `${PRICE_API}?begin=${encodeURIComponent(beginZid)}&end=${encodeURIComponent(endZid)}&type=${type}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: `${SITE}/lines/query/ticket` }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      const env = (await res.json()) as ZzApiEnvelope<ZzPriceData>;
      if (!env.status || !env.data) return null;
      return env.data;
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    }
  }
  console.log(`  price ${beginZid}->${endZid}: ${lastErr}`);
  return null;
}

export async function fetchZhengzhouSources(): Promise<ZhengzhouSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  console.log('  fetch api.zzmetro.com stations');
  const stationsData = await fetchZzStations();
  console.log('  fetch api.zzmetro.com lines');
  const lines = { ...stationsData.lines, ...(await fetchZzLines()) };
  console.log('  fetch operating_hours HTML');
  const operatingHoursHtml = await fetchOperatingHours();
  console.log('  fetch station page HTML');
  const stationPageHtml = await fetchStationPage();
  console.log('  fetch AMap subway 4101_drw_zhengzhou.json');
  const amap = await fetchAmapSubway();
  return {
    lines,
    stations: stationsData.stations,
    operatingHoursHtml,
    stationPageHtml,
    amap
  };
}
