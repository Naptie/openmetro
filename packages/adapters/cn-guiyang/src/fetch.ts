/**
 * Official-source fetch for cn-guiyang.
 *
 * The operator is 贵阳市公共交通投资运营集团有限公司 (formerly
 * 贵阳市城市轨道交通运营有限公司); its website is **www.gymetro.com.cn** does
 * not resolve — the live site is `https://www.gyurt.com/`.
 *
 * Three official inputs are used:
 *
 * - `GET /subwayInquiry.html`
 *   The "线路，票价查询" page. Its station dropdowns are the operator's own
 *   machine-readable station list: every `<li>` carries
 *   `index_number="<line id>"` and `index_origin="<lat>,<lng>"`, so the page
 *   yields the authoritative line order **and** the operator's coordinate
 *   string for every stop.
 *
 *   The coordinates are **not** GCJ-02: measured against the AMap Subway
 *   dataset they are a constant ≈983 m shift (north 663 m / east 649 m) with a
 *   residual spread of ~32 m, i.e. a local survey datum. The canonical
 *   dataset in this repository is GCJ-02, so AMap supplies the canonical
 *   coordinates and the operator's strings are used **only** as the key for
 *   the planner API, which matches stations by exact coordinate string.
 *
 * - `GET https://cms.gyurt.com/external/interface/getSubwayLines?origin=…&destination=…`
 *   The operator's own route/fare planner. One call returns the whole plan:
 *   per-leg line + stop sequence + per-stop coordinates, per-leg in-vehicle
 *   duration and distance, the boarding station's first/last train for that
 *   direction, the interchange walk distance and the OD fare.
 *
 * - `GET https://www.gyurt.com/materialpub/gdyy/images/ditiexianlutu.png`
 *   The official network map. It carries the authoritative **English** names
 *   for every station (the same names AMap publishes) and the line colours.
 *
 * Coordinates, schematic pixels, English names and per-line station codes come
 * from the public AMap subway dataset (city code 5201), which is GCJ-02 native.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const GY_SITE = 'https://www.gyurt.com';
export const GY_INQUIRY_URL = `${GY_SITE}/subwayInquiry.html`;
export const GY_CMS = 'https://cms.gyurt.com';
export const GY_PLANNER_PATH = '/external/interface/getSubwayLines';
export const GY_LINE_MAP_URL = `${GY_SITE}/materialpub/gdyy/images/ditiexianlutu.png`;

export const GY_REFERER = GY_INQUIRY_URL;

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/5201_drw_guiyang.json';
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

/** One stop as published in the operator's station dropdown. */
export interface OfficialStop {
  /** Operator line id (`1`, `2`, `3`, `S1`). */
  lineId: string;
  /** Station name exactly as the operator spells it. */
  name: string;
  /** The operator's coordinate string `lat,lng` — the planner API key. */
  coord: string;
}

export interface AmapStation {
  n?: string;
  /** Empty for this network; the English name lives in `multilang.n.en`. */
  en?: string;
  /** CamelCase pinyin. */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  /** Per-line station code (the operator publishes no codes of its own). */
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
  multilang?: { n?: { en?: string; zh?: string } };
}

export interface AmapLine {
  ln?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface GuiyangSources {
  /** The operator's station list, in line order. */
  officialStops: OfficialStop[];
  /** AMap subway dataset (GCJ-02 native). */
  amap: AmapSubwayDoc;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse the attributes of one HTML tag body. */
function attrsOf(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagBody.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/**
 * Parse the operator's station list out of the inquiry page.
 *
 * The page renders the list twice — once for the origin picker (`index_origin`)
 * and once for the destination picker (`index_destination`) — and additionally
 * carries a commented-out S1 reverse-direction block whose coordinates are
 * empty. Only `index_origin` entries with a coordinate are kept, de-duplicated
 * by (line, name).
 */
export function parseOfficialStops(html: string): OfficialStop[] {
  const seen = new Set<string>();
  const out: OfficialStop[] = [];
  for (const m of html.matchAll(/<li([^>]*)>([^<]*)<\/li>/g)) {
    const attrs = attrsOf(m[1] ?? '');
    const coord = (attrs.index_origin ?? '').trim();
    const name = (m[2] ?? '').trim();
    const lineId = (attrs.index_number ?? '').trim();
    if (!coord || !name || !lineId) continue;
    const key = `${lineId}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lineId, name, coord });
  }
  return out;
}

/**
 * Fetch the operator's station list.
 *
 * The inquiry page is the operator's live "线路，票价查询" form; it is the only
 * place where the machine-readable station list is published.
 */
export async function fetchOfficialStops(): Promise<OfficialStop[]> {
  const html = await getText(GY_INQUIRY_URL, GY_REFERER);
  const stops = parseOfficialStops(html);
  if (stops.length < 50) {
    throw new Error(
      `official station list looks truncated: ${stops.length} stops (expected >= 50)`
    );
  }
  return stops;
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
}

export async function fetchGuiyangSources(): Promise<GuiyangSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch official subwayInquiry.html (station list)');
  const officialStops = await fetchOfficialStops();
  const officialLines = new Set(officialStops.map((s) => s.lineId));
  console.log(
    `    ${officialStops.length} stops across ${officialLines.size} lines: ${[...officialLines].join(', ')}`
  );

  console.log('  fetch AMap subway 5201_drw_guiyang.json');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    ${(amap.l ?? []).length} lines, ${amapStops} stop rows`);

  if (officialLines.size < 4 || officialStops.length < 90) {
    throw new Error(
      `official station list looks truncated: ${officialStops.length} stops on ${officialLines.size} lines ` +
        '(expected 4 lines / >= 90 stops)'
    );
  }

  return { officialStops, amap };
}
