/**
 * Official-source fetch for cn-changchun.
 *
 * The operator website (www.ccqg.com, 长春市轨道交通集团有限公司) publishes
 * the whole operating network through one unauthenticated JSON endpoint —
 * the very endpoint its own "乘车查询" page calls:
 *
 * - `POST /api/v1/getLines` → every operating line with its stops in line
 *   order, per-stop official codes, GCJ-02 coordinates, the interchange map
 *   and the per-station first/last train times.
 *
 * Two operational facts drive this module:
 *
 * 1. **The site is HTTP-only.** Its HTTPS endpoint fails the TLS handshake
 *    from every client tried (direct egress and the local proxy alike), so
 *    `CC_SITE` must stay `http://`. `proxyUrl` still applies so a CN reverse
 *    proxy can front it.
 * 2. **The feed has quirks this module normalises** (see the interfaces
 *    below): a UTF-8 BOM, a stray full-width quote at the end of every 5号线
 *    coordinate, and a set of stale line-level fields that must not be used.
 *
 * The operator publishes its per-station timetable only as JPEG images
 * (`/1hx4` … `/8hx4`, plus the combined 首末班及换乘时间表 notice), so the
 * timetable layer is harvested from the Baidu planner instead — there is no
 * OCR path, exactly as in cn-jinan / cn-urumqi / cn-xian / cn-shijiazhuang.
 *
 * English names, pinyin, schematic pixels and line colours come from the
 * public AMap subway dataset (city code 2201), whose 142 station names match
 * the official feed exactly.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

/** HTTP-only on purpose — the operator's HTTPS endpoint fails the handshake. */
export const CC_SITE = 'http://www.ccqg.com';
export const CC_GET_LINES = `${CC_SITE}/api/v1/getLines`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/2201_drw_changchun.json';
export const AMAP_REFERER = `${CC_SITE}/`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A coordinate from the official feed.
 *
 * Every 5号线 coordinate carries a stray full-width right single quote
 * (`43.783018’`), so the raw strings must be cleaned before parsing.
 */
export function parseOfficialCoord(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

/** Official feed envelope. */
export interface CcEnvelope<T> {
  status?: number | string;
  message?: string;
  data?: T;
}

/**
 * One official line.
 *
 * The line-level fields are **not reliable** and the adapter must not use
 * them: `standnumber` disagrees with the real stop count on lines 2/3/4,
 * `firststand` / `endstand` still name superseded termini (4号线 ends at
 * 天新路, not 车场站), `linecolour` is only the numeric code `01`…`08`
 * rather than a hex colour, and the line-level first/last window is a
 * network-wide operating window — on lines 7 and 8 it is byte-identical.
 * Only `standList` is authoritative.
 */
export interface CcLine {
  cname: string;
  /** Official line code, `01` … `08`. */
  linecode: string;
  /** Numeric colour code, `01` … `08` — not a hex colour. */
  linecolour?: string;
  indexno?: number;
  /** Stale: disagrees with `standList.length` on lines 2, 3 and 4. */
  standnumber?: number;
  status?: string;
  upfirstdate?: string;
  uplastdate?: string;
  downfirstdate?: string;
  downlastdate?: string;
  /** Stale: superseded termini. */
  firststand?: string;
  /** Stale: superseded termini. */
  endstand?: string;
  standList: CcStop[];
}

/**
 * One official stop (a station as it appears on this line).
 *
 * `transferinfo` names the **official stop code of the same physical station
 * on another line** (1号线 人民广场 → `0535`, 8号线 北环城路 → `0121`), so
 * the interchange map is published by the operator itself.
 */
export interface CcStop {
  /** Official Chinese station name. */
  cname: string;
  /** Official per-line stop code, e.g. `0121`. */
  standcode: string;
  id: string;
  /** GCJ-02 latitude; may carry a stray full-width quote. */
  latitude: string;
  /** GCJ-02 longitude; may carry a stray full-width quote. */
  longitude: string;
  /** AMap POI id of the same station. */
  gaodeid: string;
  /** `1` when the station is an interchange. */
  istransfer: string;
  /** Official stop code of the same station on the other line(s). */
  transferinfo: string;
  sTATIC?: string;
  scale?: number;
  /** Terminal of the "up" direction (towards `standList[0]`). */
  upstand: string;
  /** Terminal of the "down" direction (towards `standList[last]`). */
  downstand: string;
  /** First train at this station towards `upstand`. */
  upfirstdate: string;
  /** Last train at this station towards `upstand`. */
  uplastdate: string;
  /** First train at this station towards `downstand`. */
  downfirstdate: string;
  /** Last train at this station towards `downstand`. */
  downlastdate: string;
}

export interface AmapStation {
  n?: string;
  en?: string;
  /** CamelCase pinyin (`BeiHuanCheng Lu`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  lo?: string | number;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface ChangchunSources {
  /** Official lines, each with its stops in line order. */
  lines: CcLine[];
  amap: AmapSubwayDoc;
}

async function fetchText(url: string, init: RequestInit = {}, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        ...init,
        headers: { ...officialFetchHeaders(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      // The official endpoint answers with a UTF-8 BOM.
      return (await res.text()).replace(/^\uFEFF/, '');
    } catch (err) {
      lastErr = err;
      const delay = 1200 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, init: RequestInit = {}, retries = 4): Promise<T> {
  return JSON.parse(await fetchText(url, init, retries)) as T;
}

/** The official line + stop registry. */
export async function fetchOfficialLines(): Promise<CcLine[]> {
  const env = await getJson<CcEnvelope<{ lines?: CcLine[] }>>(CC_GET_LINES, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${CC_SITE}/xccx`
    }
  });
  const data = env.data?.lines;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`ccqg /api/v1/getLines failed: ${env.message || 'empty'}`);
  }
  return data;
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return getJson<AmapSubwayDoc>(AMAP_SUBWAY, { headers: { Referer: AMAP_REFERER } });
}

export async function fetchChangchunSources(): Promise<ChangchunSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch official POST /api/v1/getLines');
  const lines = await fetchOfficialLines();
  console.log(`    ${lines.length} lines: ${lines.map((l) => l.cname).join(', ')}`);

  console.log('  fetch AMap subway 2201_drw_changchun.json');
  const amap = await fetchAmapSubway();

  const officialStops = lines.reduce((n, l) => n + l.standList.length, 0);
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  if (lines.length !== 8 || officialStops < 160) {
    throw new Error(
      `ccqg feed looks truncated: ${lines.length} lines, ${officialStops} stops (expected 8 lines / >= 160 stops)`
    );
  }
  console.log(`    official ${officialStops} stop rows, AMap ${amapStops} stop rows`);

  return { lines, amap };
}
