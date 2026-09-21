import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const HELIOS = 'https://www.wuhanrt.com/helios';
export const ROUTE_API = 'https://advh5.whrtmpay.com/lmap/route';
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/4201_drw_wuhan.json';
export const SITE = 'https://www.wuhanrt.com';

/** Timetable CMS columns: line display key → metroArticle firstClass. */
export const TIMETABLE_FIRST_CLASS: Record<string, string> = {
  '1号线': '1091',
  '2号线': '1093',
  '3号线': '1095',
  '4号线': '1097',
  '5号线': '1099',
  '6号线': '1101',
  '7号线': '1103',
  '8号线': '1105',
  '11号线': '1107',
  '16号线': '1109',
  '21号线（阳逻线）': '1111',
  '19号线': '1121',
  '12号线': '1273'
};

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

export interface WhLineRow {
  lineInfo?: string;
  lineName: string;
  lineColor?: string;
}

export interface WhSiteRow {
  exitInfo?: string;
  id: string;
  lineName: string;
  picture?: string;
  px?: number | string;
  siteInfo?: string;
  siteName: string;
  trainSchedule?: string;
}

export interface WhMapStation {
  n?: string;
  si?: string;
  sid?: string;
  sl?: string;
  sp?: string;
  p?: string;
  r?: string;
  t?: string;
  lg?: string;
  poiid?: string;
}

export interface WhMapLine {
  kn?: string;
  ln?: string;
  cl?: string;
  st?: WhMapStation[];
  c?: string | string[];
  la?: string;
  el?: string;
}

export interface WhMapDoc {
  s?: string;
  i?: string;
  l?: WhMapLine[];
  o?: unknown;
}

export interface WhWiringResponse {
  content: string;
  createTime?: string | number;
  releaseTime?: string | number;
}

export interface WhArticleRecord {
  id: number | string;
  title?: string;
  content?: string;
  contentAbstract?: string;
  releaseTime?: string;
  updateTime?: string;
  attachment?: string;
  firstClass?: string | number;
}

export interface WhArticleListResponse {
  code?: number;
  data?: {
    records?: WhArticleRecord[];
    total?: number;
  };
}

export interface AmapStationRaw {
  n?: string;
  en?: string;
  sp?: string;
  sl?: string;
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  r?: string;
  multilang?: { n?: { en?: string } };
}

export interface AmapLineRaw {
  ln?: string;
  kn?: string;
  cl?: string;
  la?: string;
  el?: string;
  st?: AmapStationRaw[];
  li?: string;
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLineRaw[];
}

export interface WuhanSources {
  lines: WhLineRow[];
  sites: WhSiteRow[];
  wiring: WhMapDoc;
  amap: AmapSubwayDoc;
  /** lineKey → newest timetable article content (HTML). */
  timetableArticles: Record<string, WhArticleRecord>;
}

export interface RouteSegment {
  startname?: string;
  endname?: string;
  passdepotname?: string;
  linecode?: string;
  stationNum?: number | string;
  duration?: number | string;
  outDuration?: number | string;
  outFlag?: boolean;
  direction?: string;
}

export interface RoutePath {
  typename?: string;
  duration?: number | string;
  amount?: number | string;
  segmentBoList?: RouteSegment[];
}

export interface RouteResponse {
  success?: boolean;
  rtData?: {
    buslist?: RoutePath[];
    mapVersion?: unknown;
    stationVersion?: unknown;
  };
}

export interface PathPhpDetail {
  line?: string;
  direction?: string;
  stations?: string[];
  transfer?: string;
}

export interface PathPhpPath {
  type?: { value?: string };
  distance?: { value?: number | string; unit?: string };
  time?: { value?: number | string; unit?: string };
  price?: { value?: number | string };
  transfer?: { value?: number | string };
  pass?: { value?: number | string };
  details?: PathPhpDetail[];
}

export interface PathPhpResponse {
  from?: string;
  to?: string;
  result?: number;
  paths?: PathPhpPath[];
}

export async function fetchWuhanRoute(
  startStationName: string,
  endStationName: string
): Promise<RouteResponse | null> {
  try {
    const res = await fetch(proxyUrl(ROUTE_API), {
      method: 'POST',
      headers: officialFetchHeaders({
        'Content-Type': 'application/json',
        Referer: `${SITE}/`,
        Accept: 'application/json, text/plain, */*'
      }),
      body: JSON.stringify({ startStationName, endStationName, jsVersion: 3 }),
      signal: AbortSignal.timeout(40_000)
    });
    if (!res.ok) return null;
    return (await res.json()) as RouteResponse;
  } catch {
    return null;
  }
}

export async function fetchWuhanPathPhp(from: string, to: string): Promise<PathPhpResponse | null> {
  const url = proxyUrl(
    `${HELIOS}/path/export/path.php?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );
  try {
    const res = await fetch(url, {
      headers: officialFetchHeaders({ Referer: `${SITE}/` }),
      signal: AbortSignal.timeout(40_000)
    });
    if (!res.ok) return null;
    return (await res.json()) as PathPhpResponse;
  } catch {
    return null;
  }
}

async function fetchLatestTimetableArticle(firstClass: string): Promise<WhArticleRecord | null> {
  const listUrl = `${HELIOS}/api/rest/metroArticle/queryByPage?page=0&size=5&firstClass=${firstClass}`;
  const list = await getJson<WhArticleListResponse>(listUrl);
  const records = list.data?.records ?? [];
  if (records.length === 0) return null;
  // Prefer the record that already carries HTML content; else fetch detail.
  const withContent = records.find((r) => (r.content ?? '').length > 500);
  if (withContent) return withContent;
  const id = records[0]?.id;
  if (id == null) return null;
  const info = await getJson<WhArticleListResponse>(
    `${HELIOS}/api/rest/metroArticle/info?id=${encodeURIComponent(String(id))}`
  );
  const rec = info.data?.records?.[0];
  return rec ?? null;
}

/** Official helios + AMap sources, fetched live for each sync. */
export async function fetchWuhanSources(
  opts: { skipTimetableArticles?: boolean } = {}
): Promise<WuhanSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch metroLine/queryAllList');
  const lineRes = await getJson<{ code?: number; data?: WhLineRow[] }>(
    `${HELIOS}/api/rest/metroLine/queryAllList`
  );
  const lines = lineRes.data ?? [];

  console.log('  fetch metroSite/queryAllList');
  const siteRes = await getJson<{ code?: number; data?: WhSiteRow[] }>(
    `${HELIOS}/api/rest/metroSite/queryAllList`
  );
  const sites = siteRes.data ?? [];

  console.log('  fetch metroWiringDiagram/queryInfo');
  const wiringRes = await getJson<{ code?: number; data?: WhWiringResponse }>(
    `${HELIOS}/api/rest/metroWiringDiagram/queryInfo`
  );
  const wiring = JSON.parse(wiringRes.data?.content ?? '{"l":[]}') as WhMapDoc;

  console.log('  fetch AMap subway 4201_drw_wuhan.json');
  const amap = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, 'https://map.amap.com/');

  const timetableArticles: Record<string, WhArticleRecord> = {};
  if (!opts.skipTimetableArticles) {
    for (const [lineKey, firstClass] of Object.entries(TIMETABLE_FIRST_CLASS)) {
      console.log(`  fetch timetable article ${lineKey} (fc=${firstClass})`);
      try {
        const art = await fetchLatestTimetableArticle(firstClass);
        if (art) timetableArticles[lineKey] = art;
        else console.log(`    no timetable article for ${lineKey}`);
      } catch (err) {
        console.log(`    timetable article fail ${lineKey}: ${err}`);
      }
      await sleep(80);
    }
  }

  return { lines, sites, wiring, amap, timetableArticles };
}
