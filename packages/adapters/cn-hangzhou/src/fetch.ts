import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const HZ_API = 'https://www.hzmetro.com/api';
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3301_drw_hangzhou.json';
const AMAP_REFERER = 'https://www.hzmetro.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm<T>(url: string, body: Record<string, string>, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        method: 'POST',
        headers: officialFetchHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface HzApiEnvelope<T> {
  code: number;
  ok: boolean;
  msg?: string;
  data: T;
}

export interface HzLineMeta {
  lineCode: string;
  lineName: string;
  otherName: string | null;
  baiduUid?: string;
  description?: string;
}

export interface HzStationMeta {
  description?: string;
  stationCode: string;
  stationName: string;
  baiduStationName?: string;
  lineList: string[];
}

export interface HzTimedStation {
  sitName: string;
  baiduSitNam?: string;
  startTime?: string;
  endTime?: string;
  stationCode?: string;
}

export interface HzDirection {
  title: string;
  id?: string | null;
  allStation: HzTimedStation[];
}

export interface HzOperationAll {
  title?: string;
  lineList: HzLineMeta[];
  subwaySiteDetail: Record<string, HzDirection[]>;
  subwaySiteInfo?: Record<string, unknown>;
  stationlist: HzStationMeta[];
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

export interface HangzhouSources {
  operationAll: HzOperationAll;
  amapSubway: AmapSubwayDoc;
}

/** Official Hangzhou Metro operation feed + AMap subway map used by the site. */
export async function fetchHangzhouSources(): Promise<HangzhouSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  console.log('  fetch hzmetro /api/operation/all');
  const operationAll = await postForm<HzApiEnvelope<HzOperationAll>>(`${HZ_API}/operation/all`, {});
  if (!operationAll?.ok || !operationAll.data) {
    throw new Error(`hzmetro operation/all failed: ${operationAll?.msg ?? 'unknown'}`);
  }
  console.log('  fetch AMap subway 3301_drw_hangzhou.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  return { operationAll: operationAll.data, amapSubway };
}

/** Official OD fare (yuan as string). Invalid pairs return `"--"`. */
export async function fetchHangzhouFare(startName: string, endName: string): Promise<string> {
  const env = await postForm<HzApiEnvelope<string>>(`${HZ_API}/operation/fare`, {
    startStationName: startName,
    endStationName: endName
  });
  return env?.data == null ? '--' : String(env.data);
}
