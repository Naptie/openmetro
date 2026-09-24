import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const SITE = 'https://www.chengdurail.com';
const STATION_TIME = `${SITE}/op/station-time`;
const TRAVEL = `${SITE}/system/resource/cddt/getTravel.jsp`;
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/5101_drw_chengdu.json';

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

async function postForm<T>(
  url: string,
  body: Record<string, string>,
  referer = `${SITE}/`,
  retries = 4
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        method: 'POST',
        headers: officialFetchHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: referer
        }),
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(45_000)
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

export interface CdStation {
  stationNo: string;
  stationName: string;
  stationNameEn: string;
  stationNameZh: string;
  stationCode: string;
  transferLines: string;
  startTime: string;
  endTime: string;
  sequence: number;
  stationCodes: { lineNo: string; stationCode: string }[];
}

export interface CdSubLine {
  lineNameEn: string;
  description: string;
  direction: string;
  color: string;
  lineSequence: number;
  stationList: CdStation[];
}

export interface CdLine {
  sequence: number;
  lineName: string;
  lineNameZh: string;
  lineNameEn: string;
  lineNo: string;
  lineColor: string;
  subLine: CdSubLine[];
}

export interface StationTimeResponse {
  code: number;
  msg: string;
  data: CdLine[];
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
  st?: AmapStation[];
  li?: string;
  c?: string | string[];
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface TravelLeg {
  actStation: string;
  endStation: string;
  lineName: string;
  lineNum: number;
  nextStation?: string;
  range: number;
  stationList: string[];
  time: number;
}

export interface TravelPlan {
  actStation: string;
  endStation: string;
  id: number;
  dis: number;
  price: number;
  time: number;
  station_len: number;
  stations: string[];
  suggestion: string[];
  transferStations: string[];
  transferTimes: number;
  type: number[];
  line: TravelLeg[];
}

export interface TravelResponse {
  code: number;
  msg: string;
  data: TravelPlan[];
}

export interface ChengduSources {
  stationTime: StationTimeResponse;
  amapSubway: AmapSubwayDoc;
}

/** Official first/last + topology feed used by the site's 首末班车 page. */
export async function fetchStationTime(): Promise<StationTimeResponse> {
  const text = await getText(STATION_TIME, `${SITE}/ckfw/smbcskb.htm`);
  const parsed = JSON.parse(text) as StationTimeResponse;
  if (parsed.code !== 0 || !Array.isArray(parsed.data)) {
    throw new Error(`chengdurail /op/station-time failed: ${parsed.msg || 'unknown'}`);
  }
  return parsed;
}

/** Official trip planner: fare, OD distance/time, path legs. */
export async function fetchTravel(
  startStation: string,
  endStation: string,
  retries = 3
): Promise<TravelPlan[]> {
  const env = await postForm<TravelResponse>(
    TRAVEL,
    { startStation, endStation },
    `${SITE}/xccxjgy.jsp?urltype=tree.TreeTempUrl&wbtreeid=2142`,
    retries
  );
  if (env.code !== 0) return [];
  return Array.isArray(env.data) ? env.data : [];
}

/** AMap subway map (GCJ-02 coords + English names) used by the official site. */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const text = await getText(AMAP_SUBWAY, `${SITE}/ckfw/xlt.htm`);
  return JSON.parse(text) as AmapSubwayDoc;
}

export async function fetchChengduSources(): Promise<ChengduSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  console.log('  fetch /op/station-time');
  const stationTime = await fetchStationTime();
  console.log('  fetch AMap subway 5101_drw_chengdu.json');
  const amapSubway = await fetchAmapSubway();
  return { stationTime, amapSubway };
}
