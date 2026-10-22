/**
 * Official-source fetch for cn-lanzhou.
 *
 * The operator website (www.lzgdjt.com, 兰州市轨道交通有限公司) is an
 * old-school JSP site with no public API documentation, but the data it needs
 * is published as **plain JavaScript literals in production assets**:
 *
 * - `GET /lzgd/template/js/serve.js`
 *   → `const lines = [{ title:'1号线', value:'1', lines:["陈官营", …] }, …]`
 *   the operating lines with their stops in line order.
 * - `GET /lzgd/template/js/fareData.js`
 *   → `window.fareData = { "陈官营": { "奥体中心": 2, … }, … }`
 *   the operator's published OD fare matrix (27 stations, 702 cells).
 * - `GET /lzgd/template/js/fareUtil.js`
 *   → `stationLines` (a copy of the topology) plus the client's route and
 *   transfer logic, which is the operator's own statement of which
 *   interchange is used when travelling between the two lines.
 *
 * `fareUtil.js` loads after `webPost.js` and **overrides** `webPost.getRoute`,
 * so the production "票价查询" widget computes its answers entirely from
 * `fareData.js` on the client. The matrix below is therefore the operator's
 * live fare source, not a stale export.
 *
 * The site's own backend is **not** used and must not be depended on:
 * - `POST /user-service/web/getLineStation` and `/web/getStationInfo` time out
 *   from every egress we tried (direct and reverse-proxied alike);
 * - every `/tb/*` path (the `accountToken`-authenticated `getRoute` and the
 *   lost-and-found feed) answers `502` with the site's own "网站正在维护中…"
 *   maintenance page, for every method and body.
 *
 * Coordinates, the schematic pixel grid, per-line station codes, pinyin and
 * line colours come from the public AMap subway dataset (city code 6201),
 * whose station names match the operator's literal one-to-one apart from the
 * bracketed alias on 兰州城市学院.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { extractAssignedLiteral } from './js-literal.js';

export const LZ_SITE = 'https://www.lzgdjt.com';
export const LZ_REFERER = `${LZ_SITE}/lzgd/serve.jsp`;

/** The operator's production assets that carry the network data. */
export const LZ_ASSETS = {
  serve: `${LZ_SITE}/lzgd/template/js/serve.js`,
  fareData: `${LZ_SITE}/lzgd/template/js/fareData.js`,
  fareUtil: `${LZ_SITE}/lzgd/template/js/fareUtil.js`
} as const;

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/6201_drw_lanzhou.json';
export const AMAP_REFERER = 'https://www.amap.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
        signal: AbortSignal.timeout(60_000)
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

async function getJson<T>(url: string, referer: string, retries = 4): Promise<T> {
  return JSON.parse(await getText(url, referer, retries)) as T;
}

// ---------------------------------------------------------------------------
// Official data shapes
// ---------------------------------------------------------------------------

/** One entry of the operator's `const lines = [...]` literal. */
export interface OfficialLineEntry {
  /** Official display name, e.g. `1号线`. */
  title: string;
  /** Official line id, e.g. `1`. */
  value: string;
  /** Stop names in line order, as the operator publishes them. */
  lines: string[];
}

/** The operator's published OD fare matrix: origin name → destination name → yuan. */
export type OfficialFareMatrix = Record<string, Record<string, number>>;

export interface AmapStation {
  n?: string;
  en?: string;
  /** CamelCase pinyin — the only English source for this network. */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  /** Per-line station code (the operator publishes no station codes of its own). */
  si?: string;
  sid?: string;
  /** `1` for interchange stations. */
  t?: string | number;
  /** Lines the station belongs to, `|`-separated line ids. */
  r?: string;
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  lo?: string | number;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface LanzhouSources {
  /** Official lines with their stops in line order. */
  officialLines: OfficialLineEntry[];
  /** The operator's published OD fare matrix. */
  officialFares: OfficialFareMatrix;
  /** AMap subway dataset (GCJ-02 native). */
  amap: AmapSubwayDoc;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse the operator's `const lines = [...]` literal out of `serve.js`.
 */
export function parseOfficialLines(js: string): OfficialLineEntry[] {
  const json = extractAssignedLiteral(js, /\bconst\s+lines\s*=/);
  const parsed = JSON.parse(json) as OfficialLineEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('serve.js: `const lines` is not a non-empty array');
  }
  for (const line of parsed) {
    if (!line?.title || !line?.value || !Array.isArray(line.lines) || line.lines.length < 2) {
      throw new Error(`serve.js: malformed line entry ${JSON.stringify(line)}`);
    }
  }
  return parsed;
}

/**
 * Parse the operator's `window.fareData = {...}` matrix out of `fareData.js`.
 */
export function parseOfficialFareMatrix(js: string): OfficialFareMatrix {
  const json = extractAssignedLiteral(js, /window\.fareData\s*=/);
  const parsed = JSON.parse(json) as OfficialFareMatrix;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('fareData.js: `window.fareData` is not an object');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/** The operator's official network literal. */
export async function fetchOfficialLines(): Promise<OfficialLineEntry[]> {
  const js = await getText(LZ_ASSETS.serve, LZ_REFERER);
  return parseOfficialLines(js);
}

/** The operator's published OD fare matrix. */
export async function fetchOfficialFareMatrix(): Promise<OfficialFareMatrix> {
  const js = await getText(LZ_ASSETS.fareData, LZ_REFERER);
  return parseOfficialFareMatrix(js);
}

/** The operator's client-side route/transfer rules (used to cross-check). */
export async function fetchOfficialFareUtil(): Promise<string> {
  return getText(LZ_ASSETS.fareUtil, LZ_REFERER);
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
}

export async function fetchLanzhouSources(): Promise<LanzhouSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch official serve.js (network literal)');
  const officialLines = await fetchOfficialLines();
  console.log(
    `    ${officialLines.length} lines: ${officialLines
      .map((l) => `${l.title}×${l.lines.length}`)
      .join(', ')}`
  );

  console.log('  fetch official fareData.js (OD fare matrix)');
  const officialFares = await fetchOfficialFareMatrix();
  const fareCells = Object.values(officialFares).reduce((n, row) => n + Object.keys(row).length, 0);
  console.log(`    ${Object.keys(officialFares).length} origins, ${fareCells} fare cells`);

  console.log('  fetch AMap subway 6201_drw_lanzhou.json');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    ${(amap.l ?? []).length} lines, ${amapStops} stop rows`);

  const officialStops = officialLines.reduce((n, l) => n + l.lines.length, 0);
  if (officialLines.length < 2 || officialStops < 20) {
    throw new Error(
      `official serve.js looks truncated: ${officialLines.length} lines, ${officialStops} stops (expected >= 2 lines / >= 20 stops)`
    );
  }

  return { officialLines, officialFares, amap };
}
