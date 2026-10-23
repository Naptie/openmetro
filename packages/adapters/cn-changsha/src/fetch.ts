/**
 * Official-source fetch for cn-changsha.
 *
 * The operator website (www.hncsmtr.com, 长沙市轨道交通集团有限公司) serves
 * its content from a Creator CMS backend that is reachable without
 * authentication:
 *
 * - `POST /creatorCMS/appManage/dt/findAllDtLineData.page`   → the 7 lines
 * - `POST /creatorCMS/appManage/dt/findDtStationData.page`    → every line-stop
 *   (`lineId` = the line's UUID)
 * - `POST /creatorCMS/appManage/dt/getDtStationInfoById.page` → one station's
 *   detail (per-exit bus connections)
 *
 * Three operational facts drive this module:
 *
 * 1. **The response body is a JSON array followed by an anti-scraping HTML
 *    comment.** The comment has a random length and a decoy link
 *    (`/test/test_html_link.php`), so `JSON.parse` on the raw body throws
 *    "Additional text encountered after finished reading JSON content" for
 *    every line whose data contains a character the comment escapes — in
 *    practice 3号线 and 6号线, which are the longest. The comment is stripped
 *    before parsing.
 * 2. **The whole site is GBK.** The CMS answers with `charset=GBK`, so the
 *    body is decoded as GB18030 (a superset of GBK that also covers the
 *    磁浮快线's 榔).
 * 3. **`www.csmtr.com` is NOT the operator.** It is an unrelated
 *    "宜城市禹濮网络有限公司" placeholder site; the operator's domain is
 *    `hncsmtr.com`.
 *
 * The static pages under `/webapp/dt/` (行程查询, 运营时刻表) sit behind a
 * path-scoped cookie challenge — the first request only plants `ID=Abcdefgh`
 * and the second returns the page. The adapter does not need them: the CMS
 * endpoints already carry the published first/last trains per station and per
 * direction.
 *
 * Coordinates, English names, line colours and the schematic pixel grid come
 * from the public AMap subway dataset (city code **4301** — the province-level
 * file; `430100_drw_changsha.json` does not exist).
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const CSMTR_SITE = 'https://www.hncsmtr.com';
/** Base of the operator's CMS endpoint family. */
export const CSMTR_DT_API = `${CSMTR_SITE}/creatorCMS/appManage/dt`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/4301_drw_changsha.json';
export const AMAP_REFERER = 'https://map.amap.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `findAllDtLineData.page` entry — one operating line. */
export interface CsmtrLine {
  /** The line's UUID; the `lineId` parameter of `findDtStationData.page`. */
  id: string;
  /** Official numeric line code (1…7). */
  code: number;
  /** Official Chinese display name (`1号线`, `磁浮快线`). */
  name: string;
  /** Official first terminus of the line. */
  startName?: string;
  /** Official last terminus of the line. */
  endName?: string;
  /** Number of stations the operator publishes for the line. */
  station_count?: number;
  createtime?: unknown;
}

/** `findDtStationData.page` entry — one line-stop. */
export interface CsmtrStation {
  /** The stop's UUID. */
  id: string;
  /** Official per-line station code (`1`…`25`, `601`…`634`). */
  stationNo: number;
  /** The line's UUID. */
  lineId: string;
  /** Official Chinese station name. */
  stationName: string;
  /** Short display name used by the route planner. */
  gddesc?: string;
  /**
   * Published first/last trains of this station, one entry per service
   * direction: `#1号线（金盆丘—尚双塘）首车：6:30 末车：23:00`.
   */
  times?: string;
  /** `"1"` when the station is an interchange. */
  huancheng?: string;
  /** Exit description (`1号口、2号口`). */
  service?: string;
  /** Bus connections per exit. */
  bus?: string;
  directionName?: string;
  needChangeLine?: string;
  changeLineName?: string;
  allLineName?: string;
  info?: string;
  createtime?: unknown;
}

/** AMap subway station. */
export interface AmapStation {
  /** Chinese station name. */
  n?: string;
  /** CamelCase pinyin (`JinXia`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  /** Transfer flag (`1` on a shared station). */
  t?: string | number;
  r?: string;
  sid?: string;
  si?: string;
  poiid?: string;
  multilang?: { n?: Record<string, string>; ln?: Record<string, string> };
}

/** AMap subway line. */
export interface AmapLine {
  /** Line name in AMap's dataset (`1号线`, `S2线`). */
  ln?: string;
  kn?: string;
  /** Line colour hex without `#`. */
  cl?: string;
  /** Direction ids, pipe separated. */
  li?: string;
  st?: AmapStation[];
  /** Per-direction alignment polylines in schematic pixels. */
  f?: { li?: string; c?: string[] }[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  /** City label (`长沙市地铁`). */
  s?: string;
  /** AMap city code (`4301`). */
  i?: string;
  l?: AmapLine[];
}

export interface ChangshaSources {
  /** Official line registry, in the operator's own order. */
  lines: CsmtrLine[];
  /** Official line-stops, keyed by the line's UUID, in official order. */
  stationsByLine: Map<string, CsmtrStation[]>;
  /** AMap subway dataset (GCJ-02 native). */
  amap: AmapSubwayDoc;
}

/**
 * Remove the anti-scraping HTML comment the CMS appends to every JSON body.
 *
 * The comment carries a decoy link and a random length, so it cannot be
 * matched exactly — the whole `<!-- … -->` block is dropped instead.
 */
export function stripCmsComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Decode a response body using the charset the server announced. */
function decodeBody(bytes: ArrayBuffer, contentType: string | null): string {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  if (charset && charset !== 'gbk' && charset !== 'gb2312' && charset !== 'gb18030') {
    return new TextDecoder(charset).decode(bytes);
  }
  // GB18030 is a superset of GBK/GB2312 and also covers the maglev line's 榔.
  return new TextDecoder('gb18030').decode(bytes);
}

/**
 * Call one CMS endpoint and return its parsed JSON payload.
 *
 * A mistyped endpoint answers with a JSP view (HTML, HTTP 200) rather than
 * JSON, so the parse failure is the loud signal that the path is wrong.
 */
async function postCmsJson<T>(path: string, body: Record<string, string>): Promise<T> {
  const url = proxyUrl(`${CSMTR_DT_API}${path}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: officialFetchHeaders({
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${CSMTR_SITE}/webapp/dt/main.jsp`,
          'X-Requested-With': 'XMLHttpRequest'
        }),
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for POST ${path}`);
      const bytes = await res.arrayBuffer();
      const text = decodeBody(bytes, res.headers.get('content-type'));
      const cleaned = stripCmsComments(text).trim();
      if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) {
        throw new Error(
          `POST ${path} returned ${cleaned.slice(0, 80)}… instead of JSON — the endpoint path is wrong`
        );
      }
      return JSON.parse(cleaned) as T;
    } catch (err) {
      lastErr = err;
      if (attempt === 3) break;
      const delay = 600 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/3 in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Official operating lines. */
export async function fetchCsmtrLines(): Promise<CsmtrLine[]> {
  const data = await postCmsJson<CsmtrLine[]>('/findAllDtLineData.page', {});
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('hncsmtr findAllDtLineData returned no lines');
  }
  return data;
}

/** Official line-stops of one line, in the operator's order. */
export async function fetchCsmtrStations(lineId: string): Promise<CsmtrStation[]> {
  const data = await postCmsJson<CsmtrStation[]>('/findDtStationData.page', { lineId });
  if (!Array.isArray(data)) {
    throw new Error(`hncsmtr findDtStationData returned a non-array for line ${lineId}`);
  }
  return data;
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const url = proxyUrl(AMAP_SUBWAY);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({ Referer: AMAP_REFERER }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for AMap subway`);
      const json = (await res.json()) as AmapSubwayDoc;
      if (!json.l?.length) throw new Error('AMap subway document has no lines');
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt === 3) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Minimum row counts the adapter depends on.
 *
 * The operator publishes 7 lines and 161 line-stop rows today. A truncated
 * feed must fail loudly rather than ship a half-stale network.
 */
const MIN_LINES = 7;
const MIN_STATION_ROWS = 150;

export async function fetchChangshaSources(): Promise<ChangshaSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch findAllDtLineData');
  const lines = await fetchCsmtrLines();
  console.log(`    ${lines.length} lines: ${lines.map((l) => l.name).join(', ')}`);

  const stationsByLine = new Map<string, CsmtrStation[]>();
  for (const line of lines) {
    console.log(`  fetch findDtStationData (${line.name})`);
    const stations = await fetchCsmtrStations(line.id);
    // The operator publishes the stops in line order via `stationNo`.
    stations.sort((a, b) => a.stationNo - b.stationNo);
    stationsByLine.set(line.id, stations);
    console.log(`    ${stations.length} stops`);
  }

  console.log('  fetch AMap subway 4301_drw_changsha.json');
  const amap = await fetchAmapSubway();
  const amapStopCount = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    AMap ${amapStopCount} stop rows across ${amap.l?.length ?? 0} lines`);

  // Sanity checks — a stale or truncated feed must fail loudly.
  if (lines.length < MIN_LINES) {
    throw new Error(
      `hncsmtr feed looks truncated: ${lines.length} lines (expected >= ${MIN_LINES})`
    );
  }
  const totalStations = [...stationsByLine.values()].reduce((n, list) => n + list.length, 0);
  if (totalStations < MIN_STATION_ROWS) {
    throw new Error(
      `hncsmtr findDtStationData looks truncated: ${totalStations} line-stop rows ` +
        `(expected >= ${MIN_STATION_ROWS})`
    );
  }
  for (const line of lines) {
    const declared = line.station_count;
    const actual = stationsByLine.get(line.id)?.length ?? 0;
    if (typeof declared === 'number' && declared !== actual) {
      throw new Error(
        `hncsmtr line ${line.name} declares ${declared} stations but published ${actual}`
      );
    }
    const withoutTimes = (stationsByLine.get(line.id) ?? []).filter((s) => !s.times?.trim());
    if (withoutTimes.length > 0) {
      throw new Error(
        `hncsmtr line ${line.name} publishes no first/last trains for ` +
          `${withoutTimes.length} stop(s) (e.g. ${withoutTimes[0]?.stationName})`
      );
    }
  }

  return { lines, stationsByLine, amap };
}
