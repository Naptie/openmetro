/**
 * Official-source fetch for cn-wuxi.
 *
 * ## The operator's site
 *
 * `www.wxmetro.net` (无锡地铁集团有限公司) is a Vue2/RuoYi CMS whose public
 * API base is `/api` on the same origin. Its **entire** public API is seven
 * endpoints, all of them CMS plumbing:
 *
 * - `GET  /api/metrows/topMenu`                     — the site column tree
 * - `GET  /api/metrows/bodyContent`                 — the homepage payload
 * - `GET  /api/metrows/getColumnInfo/{id}`          — one column
 * - `POST /api/metrows/getContentListByColumnId`    — a column's articles
 * - `GET  /api/metrows/contentDetail/{id}`          — one article
 * - `GET  /api/metrows/dictType/{name}`             — a dictionary
 * - `POST /api/metrows/jobListPage`                 — the job listings
 *
 * **None of them carries transit data** — they only deliver the articles and
 * images of the CMS columns. Every guess at a topology/timetable/fare
 * endpoint (`/api/metrows/{line,station,stop,schedule,timetable,trainTime,
 * price,routePlan,pathQuery,siteInfo,metroInfo}/list`) answers a Spring Boot
 * JSON `404`, and the RuoYi admin routes (`/api/system/*`) are not exposed at
 * all — the CDN answers the SPA shell for them.
 *
 * ## The DES envelope
 *
 * Every request body and every response payload is encrypted with
 * **DES-ECB** (key `839ab261`, PKCS7 padding) and carried as lowercase hex:
 *
 * - a `GET` path parameter is the **encrypted** id — `/getColumnInfo/{enc(68)}`;
 * - a `POST` body is the **encrypted** JSON of the request;
 * - a response carries the encrypted blob in `data` (single object) or `rows`
 *   (list).
 *
 * The key and the mode live in the site's own JavaScript bundle (module
 * `5cb8`), so the scheme is not a secret — it is simply how the CMS frames
 * its payloads. A change of key would break the adapter loudly, which is why
 * every official read below is optional: the topology, the timetable and the
 * fare matrix do not depend on it.
 *
 * ## What the site is actually used for
 *
 * - the 《无锡地铁票务规则》 prose (票务服务 column) — the **mileage tariff**;
 * - the 通告 about the standard station names of the planned lines;
 * - the network map image — the official English names and the not-yet-open
 *   stations (read by hand, see `./lines.ts`).
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

import { WX_SITE } from './lines.js';

/**
 * AMap's subway dataset (city code 3202, spell `wuxi`).
 *
 * A plain static JSON file — no key, no signing. It is the only machine-
 * readable source of the operating network: the line roster, the per-line
 * station order, GCJ-02 coordinates, the real English names
 * (`multilang.n.en`, populated for all 97 station rows), the line colours and
 * the schematic pixel grid.
 */
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3202_drw_wuxi.json';
export const AMAP_REFERER = 'https://map.amap.com/';

/** The operator's API base. */
export const WX_API_BASE = `${WX_SITE}/api`;

/**
 * The CMS's DES key.
 *
 * The key is a 32-character hex string, but DES only takes 8 bytes, so the
 * effective key is its first eight characters. The site's bundle declares the
 * same literal and feeds it to `CryptoJS.DES` the same way.
 */
const WX_DES_KEY = '839ab261';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Encrypt a string the way the operator's CMS does (DES-ECB → lowercase hex). */
export function wxEncrypt(plain: string): string {
  const cipher = createCipheriv('des-ecb', Buffer.from(WX_DES_KEY, 'utf8'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex');
}

/** Decrypt a CMS payload (lowercase hex → UTF-8). */
export function wxDecrypt(hex: string): string {
  const decipher = createDecipheriv('des-ecb', Buffer.from(WX_DES_KEY, 'utf8'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

/**
 * Expand `{enc:<value>}` placeholders in a path.
 *
 * The site puts the **encrypted** id in the path — `/getColumnInfo/{enc(68)}`
 * — so every id that reaches the API has to be framed the same way.
 */
export function expandEncryptedPath(path: string): string {
  return path.replace(/\{enc:([^}]+)\}/g, (_m, value: string) => wxEncrypt(value));
}

interface WxApiResponse {
  code?: number;
  msg?: string | null;
  /** Encrypted payload of a single-object endpoint. */
  data?: string;
  /** Encrypted payload of a list endpoint. */
  rows?: string;
  total?: number;
}

/**
 * GET one of the operator's CMS endpoints and return the decoded payload.
 *
 * The response's `data`/`rows` field is the DES ciphertext; it is decrypted
 * here so callers see plain JSON.
 */
export async function wxApiGet<T = unknown>(path: string, retries = 4): Promise<T | undefined> {
  const url = `${WX_API_BASE}${expandEncryptedPath(path)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({
          Accept: 'application/json, text/plain, */*',
          Referer: `${WX_SITE}/`
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
      const body = (await res.json()) as WxApiResponse;
      if (body.code !== 200) {
        throw new Error(`GET ${path} -> code=${body.code} msg=${body.msg}`);
      }
      const blob = body.data ?? body.rows;
      if (!blob) return undefined;
      return JSON.parse(wxDecrypt(blob)) as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * POST one of the operator's CMS endpoints and return the decoded payload.
 *
 * The request body is the DES ciphertext of the request JSON.
 */
export async function wxApiPost<T = unknown>(
  path: string,
  payload: unknown,
  retries = 4
): Promise<T | undefined> {
  const url = `${WX_API_BASE}${expandEncryptedPath(path)}`;
  const body = wxEncrypt(JSON.stringify(payload));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        method: 'POST',
        headers: officialFetchHeaders({
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Referer: `${WX_SITE}/`
        }),
        body,
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
      const json = (await res.json()) as WxApiResponse;
      if (json.code !== 200) {
        throw new Error(`POST ${path} -> code=${json.code} msg=${json.msg}`);
      }
      const blob = json.data ?? json.rows;
      if (!blob) return undefined;
      return JSON.parse(wxDecrypt(blob)) as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── AMap ──────────────────────────────────────────────────────────────

/** One station as AMap publishes it. */
export interface AmapStation {
  /** Chinese station name. */
  n?: string;
  /** Top-level English name — empty for Wuxi. */
  en?: string;
  /** CamelCase pinyin (`YanQiao`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  /** Interchange flag. */
  t?: string | number;
  /** AMap POI id. */
  poiid?: string;
  /** Per-language labels — `multilang.n.en` carries the real English name. */
  multilang?: { n?: Record<string, string>; ln?: Record<string, string> };
}

/** One line as AMap publishes it. */
export interface AmapLine {
  /** Chinese line name (`1号线`, `S1线`). */
  ln?: string;
  /** Full line name (`地铁1号线`). */
  kn?: string;
  /** Line colour hex, no `#` (`EE3F42`). */
  cl?: string;
  /** `1` when the line is a loop. */
  lo?: string | number;
  /** Direction ids, pipe separated. */
  li?: string;
  /** The line's stations, in the operator's line order. */
  st?: AmapStation[];
  /** Per-language line labels. */
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

/** The AMap subway document for one city. */
export interface AmapSubwayDoc {
  /** City label (`无锡市地铁`). */
  s?: string;
  /** AMap city code (`3202`). */
  i?: string;
  /** The lines. */
  l?: AmapLine[];
}

/** GET the AMap subway dataset. */
export async function fetchAmapSubway(retries = 4): Promise<AmapSubwayDoc> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(AMAP_SUBWAY), {
        headers: officialFetchHeaders({
          Accept: 'application/json,*/*',
          Referer: AMAP_REFERER
        }),
        signal: AbortSignal.timeout(45_000)
      });
      if (!res.ok) throw new Error(`GET AMap subway -> ${res.status}`);
      const doc = (await res.json()) as AmapSubwayDoc;
      if (!doc.l?.length) throw new Error('AMap subway document has no lines');
      return doc;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Official CMS reads ────────────────────────────────────────────────

/** One column of the operator's CMS. */
export interface WxColumn {
  columnId: number;
  columnName: string;
  /** The column's body — HTML prose and image references. */
  columnIntroduce?: string;
  columnTempleteId?: number;
  updateTime?: string;
}

/** Read one CMS column (the passenger-service columns are 68/70/71). */
export async function fetchOfficialColumn(columnId: number): Promise<WxColumn | undefined> {
  return wxApiGet<WxColumn>(`/metrows/getColumnInfo/{enc:${columnId}}`);
}

/** One article of the operator's CMS. */
export interface WxContent {
  contentId: number;
  title: string;
  /** The article body — HTML prose. */
  contentDetail?: string;
  contentIntroduce?: string;
  releaseTime?: string;
}

/** Read one CMS article. */
export async function fetchOfficialContent(contentId: number): Promise<WxContent | undefined> {
  return wxApiGet<WxContent>(`/metrows/contentDetail/{enc:${contentId}}`);
}

/**
 * The plain text of one CMS column.
 *
 * The passenger-service columns carry HTML, so the markup is stripped to make
 * the prose searchable (the tariff paragraph in particular).
 */
export function columnPlainText(column: WxColumn | undefined): string {
  if (!column?.columnIntroduce) return '';
  return column.columnIntroduce
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything the official site contributed to a sync. */
export interface OfficialSources {
  /** The 票务服务 column — the published ticket rules. */
  ticketing?: WxColumn;
  /** The 线路导览 column — the network map reference. */
  routeMap?: WxColumn;
  /** The 列车时刻表 column — the timetable sheet references. */
  timetables?: WxColumn;
  /** The notice about the planned lines' standard station names. */
  plannedLinesNotice?: WxContent;
  /** Why an official read failed (the site is optional — never fatal). */
  warnings: string[];
}

/**
 * Read the official sources.
 *
 * Every read is best-effort: the site may be unreachable, the CMS key may have
 * changed, or a column may have been restructured. None of that may fail the
 * sync, because the network itself comes from AMap and the Baidu planner. The
 * reasons are collected and reported.
 */
export async function fetchOfficialSources(): Promise<OfficialSources> {
  const warnings: string[] = [];
  const out: OfficialSources = { warnings };

  const read = async <T>(
    label: string,
    fn: () => Promise<T | undefined>
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  out.ticketing = await read('票务服务 column', () => fetchOfficialColumn(71));
  out.routeMap = await read('线路导览 column', () => fetchOfficialColumn(68));
  out.timetables = await read('列车时刻表 column', () => fetchOfficialColumn(70));
  out.plannedLinesNotice = await read('规划线路站名通告', () => fetchOfficialContent(3967));

  return out;
}
