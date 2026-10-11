/**
 * Official-source fetch for cn-fuzhou.
 *
 * The operator website (fzmtr.com) is an Astro SSR + Vue-islands site: the
 * whole network — six lines, per-station per-direction first/last trains,
 * exit info, official CMS ids — is embedded as one island-props JSON blob on
 * `/services/schedule`. There is no separate JSON API for it; the page *is*
 * the feed. OD fares are the exception: the 票价线路查询 page calls a real
 * backend, `GET /api/system/way/list` (see `fares.ts`).
 *
 * Station coordinates/romanisation come from the AMap subway dataset
 * (GCJ-02 native); the official CMS carries no coordinates (`latitude` is
 * always empty) and no English names.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const FUZ_SITE = 'https://www.fzmtr.com';
export const SCHEDULE_PAGE = `${FUZ_SITE}/services/schedule`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3501_drw_fuzhou.json';
export const AMAP_REFERER = 'https://www.fzmtr.com/';
export const WAY_LIST_API = `${FUZ_SITE}/api/system/way/list`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer: string, retries = 4): Promise<string> {
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

async function getJson<T>(url: string, referer: string, retries = 4): Promise<T> {
  return JSON.parse(await getText(url, referer, retries)) as T;
}

// ---------------------------------------------------------------------------
// Astro island props decoding
//
// The schedule page renders `<astro-island component-url="/_astro/Schedule.*"
// props="{...}">`. The props value is an HTML-escaped JSON blob in Astro's
// tagged serialization: every value is `[tag, value]` where tag 0 = literal,
// 1 = iterable; the decoder recurses and unwraps the tags.
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&'
};

function unescapeAttr(raw: string): string {
  return raw.replace(/&(?:quot|#39|#x27|lt|gt|amp);/g, (m) => ESCAPES[m] ?? m);
}

function decodeAstroValue(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && v[0] <= 5) {
    return decodeAstroValue(v[1]);
  }
  if (Array.isArray(v)) return v.map(decodeAstroValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = decodeAstroValue(val);
    }
    return out;
  }
  return v;
}

/** Pull the island-props JSON of the component whose url matches `marker`. */
export function extractIslandProps(html: string, marker: string): Record<string, unknown> {
  const re = /<astro-island[^>]*>/g;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const url = /component-url="([^"]+)"/.exec(tag)?.[1];
    if (!url?.includes(marker)) continue;
    const props = /props="([^"]*)"/.exec(tag)?.[1];
    if (!props) continue;
    return decodeAstroValue(JSON.parse(unescapeAttr(props))) as Record<string, unknown>;
  }
  throw new Error(`no astro-island matching ${marker} found`);
}

// ---------------------------------------------------------------------------
// Site shapes (subset of the CMS records the page embeds)
// ---------------------------------------------------------------------------

export interface FuzSiteStation {
  id: string;
  name: string;
  pathName: string;
  pathId: string;
  /** First/last toward the row's `startDirection` label (e.g. 往三江口). */
  startDirectionFirstTime: string;
  startDirectionLastTime: string;
  /** First/last toward the row's `endDirection` label. */
  flipDirectionFirstTime: string;
  flipDirectionLastTime: string;
  /** Newline-separated official exit list (`C出入口：…`). */
  channelInfo: string;
  sortNum: string;
  /** Station sketch / bus-info QR images on the official CMS. */
  map: string;
  qrCode: string;
  latitude: string;
  code: string;
  stationType: string;
  startDirection: string;
  endDirection: string;
  /** Express (滨海快线) first-train summaries; empty on ordinary lines. */
  fastFirstTimeText: string;
  fastEndTimeText: string;
}

export interface FuzSiteLine {
  id: string;
  name: string;
  startStation: string;
  endStation: string;
  /** `'1'` on 滨海快线. */
  isFast: string;
  color: string;
  /** Headway descriptions (高峰/平峰/低峰), verbatim from the CMS. */
  peakHour: string;
  offPeakHour: string;
  lowPeakHour: string;
  stationList: FuzSiteStation[];
}

// ---------------------------------------------------------------------------
// AMap shapes (subset)
// ---------------------------------------------------------------------------

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  sid?: string;
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  li?: string;
  st?: AmapStation[];
}

export interface AmapSubwayDoc {
  l?: AmapLine[];
}

export interface FuzSources {
  siteLines: FuzSiteLine[];
  amapSubway: AmapSubwayDoc;
}

export async function fetchFuzhouSources(): Promise<FuzSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch fzmtr.com /services/schedule (island props = whole network)');
  const scheduleHtml = await getText(SCHEDULE_PAGE, `${FUZ_SITE}/`);
  const scheduleProps = extractIslandProps(scheduleHtml, 'Schedule');
  const siteLines = scheduleProps.lines as FuzSiteLine[] | undefined;
  if (!siteLines?.length) {
    throw new Error('fzmtr.com schedule island carried no lines');
  }
  const stationCount = siteLines.reduce((n, l) => n + (l.stationList?.length ?? 0), 0);
  if (siteLines.length < 6 || stationCount < 100) {
    throw new Error(
      `fzmtr.com schedule has ${siteLines.length} lines / ${stationCount} station rows, expected >= 6 / >= 100`
    );
  }
  console.log(`    ${siteLines.length} lines, ${stationCount} station rows`);

  console.log('  fetch AMap subway 3501_drw_fuzhou.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  const amapLines = amapSubway.l?.length ?? 0;
  if (amapLines < 6) {
    throw new Error(`AMap subway doc for Fuzhou has ${amapLines} lines, expected >= 6`);
  }
  console.log(
    `    ${amapLines} lines, ${amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0)} station entries`
  );

  return { siteLines, amapSubway };
}
