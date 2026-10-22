/**
 * Official-source fetch for cn-shenyang.
 *
 * The operator website (www.symtc.com, 沈阳地铁集团有限公司) is a Vue SPA
 * whose content comes from a `cocc-website` CMS backend that is reachable
 * without authentication:
 *
 * - `GET  /cocc-website/api/v1/sysaggr/website/main/getLineList`   → the lines
 * - `GET  /cocc-website/api/v1/sysaggr/website/main/getStationList` → every line-stop
 * - `POST /cocc-website/api/v1/sysaggr/website/main/getHomePageInitData`
 *   → line metadata, station descriptions and the published first/last trains
 *
 * Three operational facts drive this module:
 *
 * 1. **`getHomePageInitData` must be POSTed.** The SPA posts it (`method:
 *    "post"` in the website.service chunk) and the POST response carries the
 *    *current* dataset; the same endpoint answered with GET serves a stale
 *    snapshot that predates 3号线's 东延线 (146 station descriptions instead of
 *    159, 292 timetable rows instead of 336). The adapter therefore always
 *    POSTs and asserts the row counts it depends on.
 * 2. **The site is a SPA catch-all.** Unknown paths are answered with HTTP 200
 *    and the app shell (HTML), so a mistyped endpoint does not fail loudly —
 *    it fails with a JSON parse error. Every response is therefore validated
 *    for a JSON envelope and for `code === "200"`.
 * 3. **There is no rate limiting.** 15 rapid requests to `getLineList` all
 *    returned 200 within ~1 s, so no throttling is needed (the operator's
 *    peers in this repo are far stricter).
 *
 * Coordinates, pinyin and the schematic pixel grid come from the public AMap
 * subway dataset (city code 2101). Its station names and per-line order match
 * the official feed one-to-one (verified 144/144 physical stations).
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const SYMTC_SITE = 'https://www.symtc.com';
/** Base of the operator's CMS API (the prefix the SPA's axios instance uses). */
export const SYMTC_API = `${SYMTC_SITE}/cocc-website/api/v1/sysaggr`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/2101_drw_shenyang.json';
export const AMAP_REFERER = 'https://map.amap.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Envelope shared by every `cocc-website` JSON endpoint. */
export interface SymEnvelope<T> {
  /** `"200"` on success. */
  code?: string;
  msg?: string;
  data?: T;
}

/** `getLineList` entry. */
export interface SymLine {
  /** Zero-padded official line id (`"01"`, `"09"`, `"10"`). */
  line_id: string;
  line_code?: string;
  line_type?: string;
  /** Official Chinese display name (`1号线`). */
  line_name: string;
  yy_id?: string;
}

/** `getStationList` entry — one row per line-stop, in line order. */
export interface SymStation {
  /** Official Chinese station name. */
  station_name: string;
  /** Official per-line station id (`0121` = 1号线 first stop). */
  station_id: string;
  /** Official per-line station code (same value as `station_id` today). */
  station_code: string;
  /** 1-based position of the stop on its line. */
  sort: number;
  /** Official line id. */
  line_id: string;
}

/** `getHomePageInitData.linesList` entry. */
export interface SymLineMeta {
  line_id: string;
  line_name: string;
  /** Operator line colour, e.g. `#cf3517`. */
  line_color?: string;
  /** Route length in km. */
  line_mileage?: string;
  /** Station count on the line. */
  station_num?: string;
  /** Opening date of the (latest opened section of the) line. */
  open_tm?: string;
  close_tm?: string;
}

/** `getHomePageInitData.stationsDescList` entry. */
export interface SymStationDesc {
  station_name: string;
  /** Official per-line station id (same id space as `getStationList`). */
  station_id: string;
  line_id: string;
  line_name?: string;
  /** Position on the line (ascending official order). */
  seq_id?: string;
  up_station_seq?: string;
  down_station_seq?: string;
  /** Interchange hub id (`H01`…`H15`); empty for a plain station. */
  xfer_station_id?: string;
  /** Billing station id — the physical station this stop belongs to. */
  billing_station_id?: string;
  /** Human description of the station location. */
  locationStr?: string;
  open_tm?: string;
  /** Operator's romanised station name, CamelCase pinyin (`ShiSanHaoJie`). */
  station_eng_name?: string;
  traf_ind?: string;
}

/**
 * `getHomePageInitData.stationsList` entry — one published first/last train
 * pair per station, per service direction.
 *
 * `tag_dir` is the operator's service-direction code:
 * - `01` — toward the **first** station of the line order,
 * - `02` — toward the **last** station of the line order,
 * - `03` — a separate service that runs on part of the line only (3号线's
 *   东延线, 方家栏↔甘官), with its own `Seq_id` numbering.
 */
export interface SymTimetableRow {
  /** Operator's station name (typo in the feed: `stat_station_nme`). */
  stat_station_nme: string;
  Line_ID: string;
  /** Official per-line station id. */
  Station_ID: string;
  tag_dir: string;
  /** Position within this direction's own sequence. */
  Seq_id: string;
  /** First departure; empty string or absent when the row carries no time. */
  Plan_First_Deptr_Tm?: string | null;
  /** Last departure; empty string or absent when the row carries no time. */
  Plan_Last_Deptr_Tm?: string | null;
}

/** `getHomePageInitData` payload (only the parts the adapter consumes). */
export interface SymHomeData {
  linesList?: SymLineMeta[];
  stationsList?: SymTimetableRow[];
  stationsDescList?: SymStationDesc[];
  serviceList?: { serviceName?: string; serviceUrl?: string; id?: string }[];
}

export interface AmapStation {
  /** Chinese station name. */
  n?: string;
  en?: string;
  /** CamelCase pinyin (`ShuangMa`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  sid?: string;
  si?: string;
  /** Transfer flag (`1` on a shared station). */
  t?: string | number;
  r?: string;
  multilang?: { n?: Record<string, string>; ln?: Record<string, string> };
}

export interface AmapLine {
  /** Official-style line name (`1号线`). */
  ln?: string;
  kn?: string;
  /** Line colour hex without `#`. */
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

export interface ShenyangSources {
  /** Official line registry. */
  lines: SymLine[];
  /** Official per-line metadata (colour, mileage, opening date). */
  lineMeta: Map<string, SymLineMeta>;
  /** Official line-stops, grouped by official line id, in line order. */
  stationsByLine: Map<string, SymStation[]>;
  /** Official station descriptions, keyed by the official per-line station id. */
  descByStationId: Map<string, SymStationDesc>;
  /** Official published first/last trains. */
  timetables: SymTimetableRow[];
  /** AMap subway dataset (GCJ-02 native). */
  amap: AmapSubwayDoc;
}

/**
 * Call one CMS endpoint and unwrap its envelope.
 *
 * The `code` check matters: a mistyped path returns the SPA shell with HTTP
 * 200, which fails the JSON parse first and the envelope check second.
 */
async function request<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  retries = 3
): Promise<T> {
  const url = proxyUrl(`${SYMTC_API}${path}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = officialFetchHeaders({
        Accept: 'application/json',
        Referer: `${SYMTC_SITE}/`
      });
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(60_000)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${method} ${path}`);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `${method} ${path} returned ${res.headers.get('content-type') ?? 'unknown content'} ` +
            `instead of JSON — the site serves its SPA shell for unknown paths`
        );
      }
      const env = json as SymEnvelope<T>;
      if (env.code !== '200') {
        throw new Error(`${method} ${path} -> code=${env.code ?? '?'} msg=${env.msg ?? '?'}`);
      }
      if (env.data === undefined || env.data === null) {
        throw new Error(`${method} ${path} returned no data`);
      }
      return env.data;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = 600 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Official operating lines. */
export async function fetchSymLines(): Promise<SymLine[]> {
  const data = await request<SymLine[]>('/website/main/getLineList', 'GET');
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('symtc getLineList returned no lines');
  }
  return data;
}

/** Official line-stops, one row per line-stop. */
export async function fetchSymStations(): Promise<SymStation[]> {
  const data = await request<SymStation[]>('/website/main/getStationList', 'GET');
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('symtc getStationList returned no stations');
  }
  return data;
}

/**
 * The operator's homepage payload: line metadata, station descriptions and the
 * published first/last trains.
 *
 * POSTed on purpose — see the module comment.
 */
export async function fetchSymHomeData(): Promise<SymHomeData> {
  const data = await request<SymHomeData>('/website/main/getHomePageInitData', 'POST', {});
  if (!data || typeof data !== 'object') {
    throw new Error('symtc getHomePageInitData returned no payload');
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
      return (await res.json()) as AmapSubwayDoc;
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
 * The GET variant of `getHomePageInitData` serves a snapshot from before
 * 3号线's 东延线 opened (146 station descriptions / 292 timetable rows); the
 * current dataset has 159 / 336. Refusing to build a half-stale network is
 * better than silently shipping the older topology.
 */
const MIN_STATION_DESC = 150;
const MIN_TIMETABLE_ROWS = 300;

export async function fetchShenyangSources(): Promise<ShenyangSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch getLineList');
  const lines = await fetchSymLines();
  console.log(`    ${lines.length} lines: ${lines.map((l) => l.line_name).join(', ')}`);

  console.log('  fetch getStationList');
  const stations = await fetchSymStations();
  console.log(`    ${stations.length} line-stop rows`);

  console.log('  fetch getHomePageInitData (POST)');
  const home = await fetchSymHomeData();

  const stationsByLine = new Map<string, SymStation[]>();
  for (const s of stations) {
    if (!stationsByLine.has(s.line_id)) stationsByLine.set(s.line_id, []);
    stationsByLine.get(s.line_id)!.push(s);
  }
  for (const list of stationsByLine.values()) list.sort((a, b) => a.sort - b.sort);

  const lineMeta = new Map<string, SymLineMeta>();
  for (const m of home.linesList ?? []) lineMeta.set(m.line_id, m);

  const descByStationId = new Map<string, SymStationDesc>();
  for (const d of home.stationsDescList ?? []) descByStationId.set(d.station_id, d);

  const timetables = home.stationsList ?? [];

  console.log('  fetch AMap subway 2101_drw_shenyang.json');
  const amap = await fetchAmapSubway();
  const amapStopCount = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    official ${stations.length} stop rows, AMap ${amapStopCount} stop rows`);

  // Sanity checks — a stale or truncated feed must fail loudly.
  if (lines.length < 6) {
    throw new Error(`symtc feed looks truncated: ${lines.length} lines (expected >= 6)`);
  }
  if (stations.length < 150) {
    throw new Error(
      `symtc getStationList looks truncated: ${stations.length} line-stop rows (expected >= 150)`
    );
  }
  if (descByStationId.size < MIN_STATION_DESC) {
    throw new Error(
      `symtc getHomePageInitData station descriptions look stale: ${descByStationId.size} ` +
        `(expected >= ${MIN_STATION_DESC}) — did the request fall back to GET?`
    );
  }
  if (timetables.length < MIN_TIMETABLE_ROWS) {
    throw new Error(
      `symtc getHomePageInitData timetables look stale: ${timetables.length} rows ` +
        `(expected >= ${MIN_TIMETABLE_ROWS}) — did the request fall back to GET?`
    );
  }

  return { lines, lineMeta, stationsByLine, descByStationId, timetables, amap };
}
