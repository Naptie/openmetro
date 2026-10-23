/**
 * Official-source fetch for cn-nanning.
 *
 * The operator website (www.nngdjt.com, 南宁轨道交通集团有限责任公司) serves
 * the whole network as **server-rendered HTML** — there is no JSON API and no
 * client-side data store. The 地铁服务 page carries:
 *
 * - the five lines with their stops in **official line order** and the
 *   operator's own station id (`data-id="subway-site-info-<id>"`);
 * - a detail block per station: `站点信息` (description), `站点出入口信息`
 *   (every exit with its landmarks), `换乘信息` (the official transfer note)
 *   and `服务设施` (a facility diagram image);
 * - one **first/last-train sheet image per line**;
 * - the operating network map.
 *
 * Every URL parameter on that page returns the very same document — the
 * `catalogIndex` / `catalogAlias` / `selectAlias` parameters only drive the
 * front-end tab switch — so exactly one request is needed:
 *
 * ```
 * GET https://www.nngdjt.com/traffic/subway/?pageIndex=1
 * ```
 *
 * The page needs no API key, no signature and no session.
 *
 * ## Known outage
 *
 * `GET /category/pageList?&sid=657004867133509&pp=pc` — the CMS list endpoint
 * behind the 出行服务 / 政策规定 tabs — answers **HTTP 502** for every
 * parameter combination (measured repeatedly over several hours, from the
 * browser as well as from the shell). The three policy articles behind it
 * (乘车须知 / 安全常识 / 出行指南) are therefore not reachable; the adapter does
 * not depend on them — the only data-bearing article, 票务须知, is reachable
 * by its own permalink.
 *
 * Coordinates, the schematic pixel grid, per-line station codes, pinyin,
 * English names and line colours come from the public AMap subway dataset
 * (city code 4501). The operator publishes no coordinates at all.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const NN_SITE = 'https://www.nngdjt.com';
export const NN_SUBWAY_PAGE = `${NN_SITE}/traffic/subway/?pageIndex=1`;
export const NN_REFERER = NN_SUBWAY_PAGE;

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/4501_drw_nanning.json';
export const AMAP_REFERER = 'https://www.amap.com/';

/** Official source identifiers used in `source_ids`. */
export const OFFICIAL_SOURCE = 'nngdjt-subway-page';
export const OFFICIAL_TIMETABLE_SOURCE = 'nngdjt-first-last-sheets';
export const AMAP_SOURCE = 'amap-subway-4501';

/** One stop of an official line, in the operator's own order. */
export interface OfficialStop {
  /** The operator's station id (`subway-site-info-<id>`). */
  officialId: string;
  /** The operator's station name — spelled exactly like the AMap dataset. */
  name: string;
}

/** One official line. */
export interface OfficialLine {
  /** Line number as the operator titles it (`'1'` … `'5'`). */
  officialId: string;
  /** Official Chinese display name (`轨道交通1号线`). */
  name: string;
  /** The two end stations, in the order the page lists them. */
  terminals: [string, string] | null;
  /** The line's stops, in official order. */
  stops: OfficialStop[];
  /** URL of the line's first/last-train sheet image, when published. */
  timetableImage: string | null;
}

/** One exit of a station, with the landmarks the operator lists for it. */
export interface OfficialExit {
  /** Exit label as published (`A口`, `B1口`, `C2口`, …). */
  exit: string;
  /** Roads / landmarks / interchanges the exit serves. */
  landmarks: string[];
}

/** The operator's detail block for one station. */
export interface OfficialStationDetail {
  /** The operator's station name. */
  name: string;
  /** Free-text station description (位置 / 站型 / 周边). */
  description?: string;
  /** Every exit the operator lists. */
  exits: OfficialExit[];
  /** The official transfer note (only interchange stations carry one). */
  transferNote?: string;
  /** URL of the facility diagram image. */
  facilitiesImage?: string;
}

/** Everything the operator's page yields. */
export interface OfficialNetwork {
  lines: OfficialLine[];
  /** Station name → the operator's detail block. */
  stations: Map<string, OfficialStationDetail>;
  /** URL of the operating network map. */
  networkMapImage: string | null;
  /** When the page was fetched. */
  retrievedAt: string;
}

// ---------------------------------------------------------------------------
// AMap subway dataset
// ---------------------------------------------------------------------------

export interface AmapStation {
  n?: string;
  en?: string;
  /** CamelCase pinyin. */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  /** Station shape on the schematic map (`x y` or `x y|x y`). */
  rs?: string;
  /** Per-line station code. */
  si?: string;
  sid?: string;
  /** `1` for interchange stations. */
  t?: string | number;
  poiid?: string;
  /** English name. */
  multilang?: { n?: { en?: string } };
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

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

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

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

/** Strip tags and collapse whitespace into non-empty lines. */
function htmlLines(html: string): string[] {
  return (
    html
      // The page carries commented-out markup (`<!-- <img src="" alt=""> -->`);
      // stripping comments first keeps the stray `-->` out of the text.
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .split('\n')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0 && !s.includes('<') && !s.includes('>'))
  );
}

/**
 * The five line blocks of the 站点信息 tab.
 *
 * The markup is a flat list of `<div class="tran-tag-li-3-main-bottom-li">`
 * blocks, each holding the line title, the two terminals and one element per
 * stop. The blocks are not nested, so the split is a plain lookahead.
 */
export function parseOfficialLines(html: string): OfficialLine[] {
  const blocks = [
    ...html.matchAll(
      /<div class="tran-tag-li-3-main-bottom-li">([\s\S]*?)(?=<div class="tran-tag-li-3-main-bottom-li">|$)/g
    )
  ].map((m) => m[1] ?? '');

  const lines: OfficialLine[] = [];
  for (const block of blocks) {
    const name = (block.match(/tran-tag-li-3-main-bottom-li-top">\s*([^<]+?)\s*</) ??
      [])[1]?.trim();
    if (!name) continue;
    const officialId = (name.match(/(\d+)号线/) ?? [])[1];
    if (!officialId) continue;

    const descBlock =
      (block.match(/tran-tag-li-3-main-bottom-li-desc">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
    const terminals = [...descBlock.matchAll(/<span>\s*([^<]+?)\s*<\/span>/g)].map((m) =>
      m[1]!.trim()
    );

    const stops: OfficialStop[] = [
      ...block.matchAll(/data-id="subway-site-info-(\d+)"[\s\S]*?<span>\s*([^<]+?)\s*<\/span>/g)
    ].map((m) => ({ officialId: m[1]!, name: m[2]!.trim() }));

    lines.push({
      officialId,
      name,
      terminals: terminals.length === 2 ? [terminals[0]!, terminals[1]!] : null,
      stops,
      timetableImage: null
    });
  }
  return lines;
}

/**
 * The per-station detail blocks.
 *
 * Each block is introduced by a heading that carries the station name in
 * parentheses — `站点信息(火车东站)`, `站点出入口信息(佛子岭)`, … — and runs until
 * the next heading. The heading markup differs between the two columns
 * (`…-l-top` and `…-l-top-r`), so both are matched.
 */
export function parseOfficialStationDetails(html: string): Map<string, OfficialStationDetail> {
  // Commented-out markup is removed first so a heading inside a comment can
  // never open a block.
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const marker =
    /li-3-main-bottom-con-li-l-top(?:-r)?">\s*(服务设施|站点出入口信息|换乘信息|站点信息)\(([^)]*)\)\s*</g;
  const hits = [...source.matchAll(marker)];
  const out = new Map<string, OfficialStationDetail>();

  const detailFor = (name: string): OfficialStationDetail => out.get(name) ?? { name, exits: [] };

  hits.forEach((hit, i) => {
    const kind = hit[1]!;
    const name = hit[2]!.trim();
    const start = hit.index + hit[0].length;
    const end = hits[i + 1]?.index ?? source.length;
    const chunk = source.slice(start, end);
    const detail = detailFor(name);

    if (kind === '站点出入口信息') {
      for (const line of htmlLines(chunk)) {
        const m = line.match(/^([A-Z]\d?口)[：:](.*)$/);
        if (!m) continue;
        detail.exits.push({
          exit: m[1]!,
          landmarks: (m[2] ?? '').trim().split(/\s+/).filter(Boolean)
        });
      }
    } else if (kind === '服务设施') {
      const img = (chunk.match(/<img[^>]*src="([^"]+)"/) ?? [])[1];
      if (img) detail.facilitiesImage = img;
    } else if (kind === '站点信息') {
      const text = htmlLines(chunk).join(' ');
      if (text) detail.description = text;
    } else {
      const text = htmlLines(chunk).join(' ');
      if (text) detail.transferNote = text;
    }

    out.set(name, detail);
  });

  return out;
}

/** The first/last-train sheet images, in the order the page lists the lines. */
export function parseTimetableImages(html: string): string[] {
  return [...html.matchAll(/<div class="subway-schedule-table">[\s\S]*?<img src="([^"]+)"/g)].map(
    (m) => m[1]!
  );
}

/** The operating network map image. */
export function parseNetworkMapImage(html: string): string | null {
  const tab =
    (html.match(/<div class="won-tran-tag-li-1-con[^"]*">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
  const img = (tab.match(/<img[^>]*src="([^"]+)"/) ?? [])[1];
  return img ?? null;
}

/**
 * Parse the operator's 地铁服务 page into its network model.
 *
 * The parse is deliberately strict: a truncated page must fail loudly rather
 * than produce a half-built network.
 */
export function parseOfficialNetwork(html: string): OfficialNetwork {
  const lines = parseOfficialLines(html);
  const images = parseTimetableImages(html);
  for (const line of lines) {
    const index = Number(line.officialId) - 1;
    line.timetableImage = images[index] ?? null;
  }
  const stations = parseOfficialStationDetails(html);
  const networkMapImage = parseNetworkMapImage(html);

  const stopRows = lines.reduce((n, l) => n + l.stops.length, 0);
  if (lines.length !== 5 || stopRows < 100) {
    throw new Error(
      `official 地铁服务 page looks truncated: ${lines.length} lines, ${stopRows} line-stops (expected 5 lines / 107 line-stops)`
    );
  }
  if (stations.size < 90) {
    throw new Error(
      `official 地铁服务 page carries only ${stations.size} station detail blocks (expected >= 90)`
    );
  }

  return {
    lines,
    stations,
    networkMapImage,
    retrievedAt: new Date().toISOString()
  };
}

/** The operator's 地铁服务 page, parsed. */
export async function fetchOfficialNetwork(): Promise<OfficialNetwork> {
  const html = await getText(NN_SUBWAY_PAGE, NN_REFERER);
  return parseOfficialNetwork(html);
}

// ---------------------------------------------------------------------------
// Everything the adapter needs
// ---------------------------------------------------------------------------

export interface NanningSources {
  /** The operator's page, parsed. */
  official: OfficialNetwork;
  /** AMap subway dataset (GCJ-02 native). */
  amap: AmapSubwayDoc;
}

export async function fetchNanningSources(): Promise<NanningSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch official 地铁服务 page (topology, station detail, timetable sheets)');
  const official = await fetchOfficialNetwork();
  console.log(
    `    ${official.lines.length} lines: ${official.lines
      .map((l) => `${l.name}×${l.stops.length}`)
      .join(', ')} | ${official.stations.size} station detail blocks`
  );

  console.log('  fetch AMap subway 4501_drw_nanning.json');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    ${(amap.l ?? []).length} lines, ${amapStops} stop rows`);
  if ((amap.l ?? []).length === 0) {
    throw new Error('amap subway 4501 returned no lines');
  }

  return { official, amap };
}
