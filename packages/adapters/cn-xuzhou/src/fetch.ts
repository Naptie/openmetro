/**
 * Official-source fetch for cn-xuzhou.
 *
 * The operator website (www.xzdtjt.com, 徐州地铁集团有限公司) publishes the
 * whole operating network through server-rendered HTML. There is **no public
 * JSON API** — every `/api/*`, `/metro/*` and `/pas-gateway-api/*` path answers
 * `404` with a Spring Boot error body — so the four official endpoints below
 * are parsed from HTML:
 *
 * - `GET /index.html`                    → the `dropBox` tree (lines, station
 *                                           order, global station ids, exits)
 * - `GET /1/54/timetable?line=N`         → the per-station first/last sheet
 * - `GET /1/53/lineSearch?start&end&…`   → route planner (fare / stops / time)
 * - `GET /1/52/station?station=ID`       → station detail (exits, landmarks)
 *
 * Two operational facts drive this module:
 *
 * 1. **A Knownsec (创宇盾) WAF fronts the site.** A request without a browser
 *    user-agent is answered with a `403` "疑似黑客攻击" page instead of the
 *    document. Every request therefore carries a full Chrome UA plus
 *    `Accept`/`Accept-Language`, and a `403` is retried with exponential
 *    backoff rather than treated as a hard failure.
 * 2. **The origin rate-limits bursts.** Requests are spaced by a minimum
 *    interval (default 400 ms) and the fare sweep additionally throttles
 *    itself, because the planner endpoint is queried thousands of times.
 *
 * Coordinates, English names, line colours and the schematic pixel grid come
 * from the public AMap subway dataset (city code 3203), whose station names
 * and per-line order match the official tree one-to-one.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const XZ_SITE = 'https://www.xzdtjt.com';
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3203_drw_xuzhou.json';
export const AMAP_REFERER = `${XZ_SITE}/`;

/** Official route-planner page id. */
export const PLANNER_PATH = '/1/53/lineSearch';
/** Official station-detail page id. */
export const STATION_PATH = '/1/52/station';
/** Official timetable page id. */
export const TIMETABLE_PATH = '/1/54/timetable';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimum spacing between two requests to the operator's origin. */
let nextAllowedAt = 0;
let minIntervalMs = 400;

export function setXuzhouRequestInterval(ms: number): void {
  minIntervalMs = Math.max(0, ms);
}

async function throttle(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowedAt = Date.now() + minIntervalMs;
}

function jitter(base: number): number {
  return base + Math.floor(Math.random() * 250);
}

export interface FetchTextOptions {
  /** Extra headers merged over the browser defaults. */
  headers?: Record<string, string>;
  /** How many attempts before giving up. */
  retries?: number;
  /** Base backoff in ms; doubles per attempt. */
  backoffMs?: number;
  /** Treat a `403` as final instead of retrying (WAF blocks are transient). */
  retryOn403?: boolean;
}

/**
 * GET a document from the operator's site.
 *
 * A `403` from the WAF is retried with exponential backoff: the shield
 * blocks bursts and short-lived fingerprints, and a retry after a pause
 * normally succeeds.
 */
export async function fetchXuzhouText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const retries = opts.retries ?? 5;
  const backoff = opts.backoffMs ?? 2000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `${XZ_SITE}/`,
          ...opts.headers
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (res.status === 403 && attempt < retries) {
        // Knownsec WAF: back off and retry.
        const delay = jitter(backoff * 2 ** attempt);
        console.log(`  WAF 403 on ${url} — retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const delay = jitter(backoff * 2 ** attempt);
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET a JSON document (AMap is not behind the WAF). */
export async function fetchJson<T>(url: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Accept: 'application/json,*/*', Referer: AMAP_REFERER }),
        signal: AbortSignal.timeout(45_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(jitter(500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Official dropBox tree ─────────────────────────────────────────────

/** One station entry of the official `dropBox` tree. */
export interface XzDropBoxStation {
  /** Global station id (1…76). */
  value: string;
  /** Official Chinese station name. */
  label: string;
  /** Exits of this station; `null` when the operator lists none. */
  children: { value: string; label: string }[] | null;
}

/** One line entry of the official `dropBox` tree. */
export interface XzDropBoxLine {
  /** Official line number (`1`, `2`, `3`, `6`). */
  value: string;
  /** Official Chinese line name (`1号线`). */
  label: string;
  /** Stations of the line, in official line order. */
  children: XzDropBoxStation[] | null;
}

/**
 * Parse the `dropBox` tree out of the homepage.
 *
 * The tree is a plain JSON literal assigned to a global on the homepage and
 * holds the operator's own line registry, per-line station order, the global
 * station ids and every station's exits.
 */
export function parseDropBox(html: string): XzDropBoxLine[] {
  const m = html.match(/var\s+dropBox\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m?.[1]) throw new Error('xzdtjt homepage: dropBox tree not found');
  const parsed = JSON.parse(m[1]) as XzDropBoxLine[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('xzdtjt homepage: dropBox tree is empty');
  }
  return parsed;
}

/** Fetch the official homepage and decode its `dropBox` tree. */
export async function fetchDropBox(): Promise<XzDropBoxLine[]> {
  const html = await fetchXuzhouText(`${XZ_SITE}/index.html`);
  return parseDropBox(html);
}

// ── Official timetable ────────────────────────────────────────────────

/** One row of the official timetable sheet. */
export interface XzTimetableRow {
  /** Official station name as the sheet prints it (6号线 adds a `站` suffix). */
  stationName: string;
  /** Header of the first direction column, e.g. `开往徐州东站`. */
  direction1: string;
  /** `HH:MM` or undefined when the operator prints `—`. */
  first1?: string;
  last1?: string;
  /** Header of the second direction column, e.g. `开往路窝`. */
  direction2: string;
  first2?: string;
  last2?: string;
}

/**
 * Parse the official `<table class="time-table">` sheet.
 *
 * The sheet is plain HTML — no OCR — with one `<tr>` per station. Each time
 * cell holds two `<div class="time-row">` blocks, a `首` (first) and a `末`
 * (last) row; the terminal station's single-direction column prints `—`.
 */
export function parseTimetable(html: string): XzTimetableRow[] {
  const table = html.match(/<table class="time-table">([\s\S]*?)<\/table>/);
  if (!table?.[1]) throw new Error('xzdtjt timetable: time-table not found');
  const body = table[1];

  const direction1 = body.match(/<th class="direction1">([^<]*)<\/th>/)?.[1]?.trim() ?? '';
  const direction2 = body.match(/<th class="direction2">([^<]*)<\/th>/)?.[1]?.trim() ?? '';

  const tbody = body.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? body;
  const rows = tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];

  const cellTimes = (td: string): { first?: string; last?: string } => {
    const out: { first?: string; last?: string } = {};
    const timeRows = td.match(/<div class="time-row">([\s\S]*?)<\/div>/g) ?? [];
    for (const tr of timeRows) {
      const note = tr.match(/<span class="note">([^<]*)<\/span>/)?.[1]?.trim();
      const time = tr.match(/<span class="time">([^<]*)<\/span>/)?.[1]?.trim();
      if (!time || !/^\d{1,2}:\d{2}$/.test(time)) continue;
      if (note === '首') out.first = time;
      else if (note === '末') out.last = time;
    }
    return out;
  };

  const out: XzTimetableRow[] = [];
  for (const row of rows) {
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    if (tds.length < 3) continue;
    const stationName = tds[0]!.match(/<span class="name">([^<]*)<\/span>/)?.[1]?.trim();
    if (!stationName) continue;
    const t1 = cellTimes(tds[1]!);
    const t2 = cellTimes(tds[2]!);
    out.push({
      stationName,
      direction1,
      first1: t1.first,
      last1: t1.last,
      direction2,
      first2: t2.first,
      last2: t2.last
    });
  }
  if (out.length === 0) throw new Error('xzdtjt timetable: no station rows');
  return out;
}

/** Fetch the official first/last sheet of one line. */
export async function fetchTimetable(lineNumber: number): Promise<XzTimetableRow[]> {
  const html = await fetchXuzhouText(`${XZ_SITE}${TIMETABLE_PATH}?line=${lineNumber}`);
  return parseTimetable(html);
}

// ── Official route planner ────────────────────────────────────────────

/** The official planner's answer for one origin/destination pair. */
export interface XzRouteResult {
  /** Official fare in yuan. */
  fare?: number;
  /** Intermediate stop count as the operator reports it. */
  stops?: number;
  /** Total travel time in minutes (operator-rounded). */
  minutes?: number;
  /** Number of transfers. */
  transfers?: number;
  /** The operator's itinerary, station by station. */
  itinerary: string[];
}

/**
 * Parse the planner's result block.
 *
 * The result renders as `票价： 2 元`, `站数： 4站`, `时长： 9分钟`,
 * `换乘： 0次`, followed by the per-leg station sequence under
 * `<div class="stations">`. The operator's `站数` counts **intervals**, so a
 * five-station itinerary reports `4站`.
 */
export function parseRouteResult(html: string): XzRouteResult | null {
  const start = html.indexOf('查询结果');
  if (start < 0) return null;
  const block = html.slice(start, start + 30_000);
  const plain = block
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const fare = plain.match(/票价：\s*(\d+)\s*元/)?.[1];
  const stops = plain.match(/站数：\s*(\d+)\s*站/)?.[1];
  const minutes = plain.match(/时长：\s*(\d+)\s*分钟/)?.[1];
  const transfers = plain.match(/换乘：\s*(\d+)\s*次/)?.[1];
  if (!fare && !stops) return null;

  const stationsStart = block.indexOf('<div class="stations">');
  const stationsEnd = block.indexOf('<!--end search result-->');
  const stationsBlock =
    stationsStart >= 0 ? block.slice(stationsStart, stationsEnd > 0 ? stationsEnd : undefined) : '';
  const itinerary = (stationsBlock.match(/<span class="name">([^<]*)<\/span>/g) ?? [])
    .map((s) => s.replace(/<[^>]+>/g, '').trim())
    .filter((s) => s.length > 0);

  return {
    fare: fare ? Number(fare) : undefined,
    stops: stops ? Number(stops) : undefined,
    minutes: minutes ? Number(minutes) : undefined,
    transfers: transfers ? Number(transfers) : undefined,
    itinerary
  };
}

/**
 * Query the official route planner.
 *
 * `sLine` / `eLine` are the operator's **0-based** line positions (0 = 1号线 …
 * 3 = 6号线); passing the line number makes the backend throw
 * `Index N out of bounds for length 4`. The planner answers with the
 * operator's own fare, stop count, duration and transfer count.
 */
export async function fetchRouteResult(
  startStationId: number,
  endStationId: number,
  startLineIndex: number,
  endLineIndex: number
): Promise<XzRouteResult | null> {
  const url =
    `${XZ_SITE}${PLANNER_PATH}` +
    `?start=${startStationId}&end=${endStationId}` +
    `&sLine=${startLineIndex}&eLine=${endLineIndex}`;
  const html = await fetchXuzhouText(url);
  return parseRouteResult(html);
}

// ── Official station detail ───────────────────────────────────────────

/** One exit of a station, as the operator's station page describes it. */
export interface XzStationExit {
  /** Exit number as printed. */
  number: string;
  /** Exit label, e.g. `1号出入口`. */
  label: string;
  /** Landmark the exit serves. */
  landmark?: string;
  /** Nearby bus routes. */
  buses?: string;
  /** Nearby bike-share dock. */
  bike?: string;
}

/** The operator's station detail page. */
export interface XzStationDetail {
  stationName: string;
  exits: XzStationExit[];
  /** In-station facilities (ticket machines, escalators, lifts, …). */
  facilities?: string;
  /** First/last trains as the station page repeats them. */
  firstLast?: { direction: string; first?: string; last?: string }[];
  /** Station layout plan images the operator publishes. */
  planPictures?: string[];
}

/**
 * Slice a region of the page between a start marker and the first of several
 * end markers.
 *
 * The operator's page is hand-written HTML whose blocks are delimited by
 * `<!--end …-->` comments, but relying on those comments alone would break
 * silently whenever the markup is re-indented. Taking the block up to the
 * **next known section** is stable against comment churn.
 */
function sliceBetween(html: string, start: string, ends: string[]): string | undefined {
  const from = html.indexOf(start);
  if (from < 0) return undefined;
  const rest = html.slice(from + start.length);
  let cut = rest.length;
  for (const end of ends) {
    const i = rest.indexOf(end);
    if (i >= 0 && i < cut) cut = i;
  }
  return rest.slice(0, cut);
}

/**
 * Parse the station detail page.
 *
 * The page is structured: `<div class="first-end-time">` carries the two
 * directions, `<div class="entrances">` one `<div class="item">` per exit
 * (number tag, name, landmark / nearby buses / bike dock), `<div class="facility">`
 * the in-station facilities and `<div class="plan-picture">` the station
 * layout plans.
 */
export function parseStationDetail(html: string): XzStationDetail | null {
  const exitBlock = sliceBetween(html, '<div class="entrances">', [
    '<!--end 出入口-->',
    '<div class="facility">',
    '<div class="plan-picture">'
  ]);
  const exitItems = exitBlock?.match(/<div class="item">([\s\S]*?)<\/div>\s*<\/div>/g) ?? [];

  const exits: XzStationExit[] = [];
  for (const item of exitItems) {
    const number = item.match(/<span class="tag[^"]*">\s*([^<]*?)\s*<\/span>/)?.[1]?.trim();
    const label = item.match(/<div class="name">([^<]*)<\/div>/)?.[1]?.trim();
    if (!number || !label) continue;
    const around = item.match(/<div class="around">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const span = (label: string): string | undefined => {
      const m = around.match(new RegExp(`${label}：\\s*<span>([\\s\\S]*?)<\\/span>`));
      const text = m?.[1]?.replace(/<[^>]+>/g, '').trim();
      return text && text !== '无' ? text : undefined;
    };
    exits.push({
      number,
      label,
      landmark: span('地标'),
      buses: span('周边公交'),
      bike: span('自行车点')
    });
  }

  const facilityBlock = sliceBetween(html, '<div class="facility">', [
    '<!--end 站内设施-->',
    '<div class="plan-picture">'
  ]);
  const facilities = facilityBlock
    ? (facilityBlock.match(/<div class="item">([\s\S]*?)<\/div>/g) ?? [])
        .map((f) =>
          f
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter((f) => f.length > 0)
    : [];

  const timeBlock = sliceBetween(html, '<div class="first-end-time">', [
    '<!--end 首末班时刻-->',
    '<div class="entrances">'
  ]);
  const firstLast: XzStationDetail['firstLast'] = [];
  if (timeBlock) {
    const items = timeBlock.match(/<div class="item">([\s\S]*?)<\/div>/g) ?? [];
    for (const item of items) {
      const direction = item.match(/<span class="direction">([^<]*)<\/span>/)?.[1]?.trim();
      if (!direction) continue;
      const times = (item.match(/<span class="time">([^<]*)<\/span>/g) ?? []).map((t) =>
        t
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, '')
          .trim()
      );
      // The operator prints an em dash where a direction has no service.
      const clean = (v: string | undefined): string | undefined =>
        v && /^\d{1,2}:\d{2}$/.test(v) ? v : undefined;
      const first = clean(times.find((t) => t.startsWith('首班'))?.replace(/^首班：/, ''));
      const last = clean(times.find((t) => t.startsWith('末班'))?.replace(/^末班：/, ''));
      firstLast.push({ direction, first, last });
    }
  }

  const planBlock = sliceBetween(html, '<div class="plan-picture">', ['<!--end 站层图-->']);
  const planPictures = (planBlock?.match(/<img src="([^"]+)"/g) ?? [])
    .map((s) => s.replace(/<img src="/, '').replace(/"$/, ''))
    .filter((s) => s.length > 0);

  if (exits.length === 0 && facilities.length === 0) return null;

  return {
    stationName: '',
    exits,
    facilities: facilities.length ? facilities.join('；') : undefined,
    firstLast: firstLast.length ? firstLast : undefined,
    planPictures: planPictures?.length ? planPictures : undefined
  };
}

/** Fetch the official station detail page of one station id. */
export async function fetchStationDetail(stationId: number): Promise<XzStationDetail | null> {
  const html = await fetchXuzhouText(`${XZ_SITE}${STATION_PATH}?station=${stationId}`);
  return parseStationDetail(html);
}

// ── AMap ──────────────────────────────────────────────────────────────

export interface AmapStation {
  /** Chinese station name. */
  n?: string;
  /** Top-level English name — empty for Xuzhou. */
  en?: string;
  /** CamelCase pinyin (`LuWo`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  /** Schematic label anchor `x y`. */
  rs?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
  /** Per-language labels — `multilang.n.en` carries the real English name. */
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  /** Chinese line name (`1号线`). */
  ln?: string;
  /** Full line name (`地铁1号线`). */
  kn?: string;
  /** Line colour hex, no `#` (`CC0000`). */
  cl?: string;
  /** `1` when the line is a loop. */
  lo?: string | number;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  /** Network name (`徐州市地铁`). */
  s?: string;
  /** City code (`3203`). */
  i?: string;
  l?: AmapLine[];
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return fetchJson<AmapSubwayDoc>(AMAP_SUBWAY);
}

// ── Source bundle ─────────────────────────────────────────────────────

export interface XuzhouSources {
  /** Official line registry with per-line station order and station ids. */
  dropBox: XzDropBoxLine[];
  /** Official first/last sheet per line number. */
  timetables: Map<number, XzTimetableRow[]>;
  amap: AmapSubwayDoc;
}

/**
 * Fetch every source the topology layer needs.
 *
 * The operator's own tree is authoritative for the line list, the station
 * order and the station ids; AMap contributes the coordinates, the English
 * names, the line colours and the schematic grid.
 */
export async function fetchXuzhouSources(): Promise<XuzhouSources> {
  console.log('  fetch official dropBox tree');
  const dropBox = await fetchDropBox();
  const stopCount = dropBox.reduce((n, l) => n + (l.children?.length ?? 0), 0);
  console.log(
    `    ${dropBox.length} lines: ${dropBox.map((l) => l.label).join(', ')} (${stopCount} stop rows)`
  );

  const timetables = new Map<number, XzTimetableRow[]>();
  for (const line of dropBox) {
    const lineNumber = Number(line.value);
    if (!Number.isFinite(lineNumber)) continue;
    const rows = await fetchTimetable(lineNumber);
    timetables.set(lineNumber, rows);
    console.log(`    ${line.label}: ${rows.length} timetable rows`);
  }

  console.log('  fetch AMap subway 3203_drw_xuzhou.json');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    AMap ${(amap.l ?? []).length} lines, ${amapStops} stop rows`);

  if (dropBox.length < 4 || stopCount < 70) {
    throw new Error(
      `xzdtjt dropBox tree looks truncated: ${dropBox.length} lines, ${stopCount} stops (expected >= 4 lines / >= 70 stops)`
    );
  }
  if (amapStops !== stopCount) {
    throw new Error(
      `AMap (${amapStops} stops) and the official tree (${stopCount} stops) disagree on the network size`
    );
  }

  return { dropBox, timetables, amap };
}
