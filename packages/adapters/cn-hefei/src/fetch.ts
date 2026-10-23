/**
 * Official-source fetch for cn-hefei.
 *
 * ## Sources
 *
 * | source | what it carries |
 * |---|---|
 * | AMap Subway `3401_drw_hefei.json` | 8 lines, 215 line-stop rows, 195 physical stations — GCJ-02 coordinates, English names, schematic pixel grid, line colours, per-direction polylines. **100 % coverage** on Hefei. |
 * | 《首末班车时间及行车间隔》 (disclosure platform) | the official first/last-train table: 8 lines × 3 service-day bands, first-train origin stations, last-train terminals, minimum headways, direction definitions. |
 * | 《票价信息及优惠政策》 (disclosure platform) | the official distance tariff in plain text, plus the discount policy. |
 * | 《运营线路》 (disclosure platform) | the official operating network map (PNG) — the source of the three 暂未开通 stations. Not OCR'd (repo convention); the map's URL is recorded as provenance. |
 *
 * ## Where the documents are found
 *
 * The disclosure platform's category listing is fetched through its **label
 * endpoint** (`/site/label/8888`), which is not behind the WAF, so the adapter
 * always picks up the newest document instead of hardcoding an id. See
 * `./gov.ts` for the WAF handling.
 */
import {
  byNewest,
  CAT_FARE_PRICE,
  CAT_OPERATING_LINES,
  type DisclosureDoc,
  fetchDisclosureList,
  fetchGovText,
  parseTables,
  textOf
} from './gov.js';
import { FARE_LADDER, FARE_LADDER_TAIL_KM } from './lines.js';
import {
  type BandTimes,
  type OfficialLineTimetable,
  parseOfficialTimetable
} from './timetables.js';

/** The operator's official site (a web-isolation shell — announcements only). */
export const HEFEI_OPERATOR_SITE = 'https://www.hfgdjt.com/';

/** The Hefei government disclosure platform's operator column. */
export const HEFEI_GOV_COLUMN = 'https://www.hefei.gov.cn/public/column/156407?type=2&nav=1';

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3401_drw_hefei.json';
export const AMAP_REFERER = 'https://map.amap.com/';

/** AMap subway station. */
export interface AmapStation {
  /** Chinese station name. */
  n?: string;
  /** CamelCase pinyin (`JiuLianWei`). */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  /** Transfer flag (`1` on a shared station). */
  t?: string | number;
  /** Per-line station id. */
  si?: string;
  /** Line ids the station belongs to (pipe separated). */
  r?: string;
  /** POI id. */
  poiid?: string;
  /** Line ids of the two directions (pipe separated). */
  li?: string;
  multilang?: { n?: Record<string, string>; ln?: Record<string, string> };
}

/** AMap subway line. */
export interface AmapLine {
  /** Line name in AMap's dataset (`1号线`). */
  ln?: string;
  kn?: string;
  /** Line colour hex without `#`. */
  cl?: string;
  /** Direction ids, pipe separated. */
  li?: string;
  st?: AmapStation[];
  /** Per-direction alignment polylines in schematic pixels. */
  f?: { li?: string; c?: string[] }[];
  /** Line-level polyline in schematic pixels. */
  c?: string[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  /** City label (`合肥市地铁`). */
  s?: string;
  /** AMap city code (`3401`). */
  i?: string;
  l?: AmapLine[];
}

/** The official tariff as published, plus the discount policy text. */
export interface OfficialFarePolicy {
  /** The ladder steps, in km/yuan. */
  steps: { upToKm: number; yuan: number }[];
  /** Kilometres each additional yuan buys beyond the last step. */
  tailKm: number;
  /** Yuan added per tail step. */
  tailYuan: number;
  /** The article's full text (kept for provenance). */
  text: string;
}

/** Everything the normalizer needs. */
export interface HefeiSources {
  amap: AmapSubwayDoc;
  /** Official first/last-train table, one entry per line. */
  timetable: OfficialLineTimetable[];
  /** The disclosure document the table came from. */
  timetableDoc: DisclosureDoc;
  /** Official tariff. */
  fare: OfficialFarePolicy;
  /** The disclosure document the tariff came from. */
  fareDoc: DisclosureDoc;
  /** URL of the official operating network map (PNG). */
  networkMapUrl?: string;
  /** The disclosure document the network map came from. */
  networkMapDoc?: DisclosureDoc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch the AMap subway dataset for Hefei. */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const url = `${AMAP_SUBWAY}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: AMAP_REFERER,
          Accept: 'application/json, text/plain, */*'
        },
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as AmapSubwayDoc;
      if (!doc.l?.length) throw new Error('AMap subway document has no lines');
      return doc;
    } catch (err) {
      lastErr = err;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Find the newest document in a disclosure category whose title matches.
 */
export async function findDisclosureDoc(
  catId: number,
  titleMatcher: RegExp
): Promise<DisclosureDoc | undefined> {
  const docs = await fetchDisclosureList(catId);
  return docs.filter((d) => titleMatcher.test(d.title)).sort(byNewest)[0];
}

/**
 * Fetch and parse the official first/last-train table.
 *
 * The newest 《…首末班车时间及行车间隔》 document wins; older ones (the
 * platform keeps the previous revisions published) are used only as a
 * fallback when the newest cannot be read.
 */
export async function fetchOfficialTimetable(): Promise<{
  timetable: OfficialLineTimetable[];
  doc: DisclosureDoc;
}> {
  const docs = (await fetchDisclosureList(CAT_OPERATING_LINES))
    .filter((d) => /首末班车时间及行车间隔/.test(d.title))
    .sort(byNewest);
  if (docs.length === 0) {
    throw new Error('hefei: no 首末班车时间及行车间隔 document found on the disclosure platform');
  }

  let lastError: unknown;
  for (const doc of docs) {
    try {
      const html = await fetchGovText(doc.url, { referer: HEFEI_GOV_COLUMN });
      const timetable = parseOfficialTimetable(parseTables(html));
      console.log(
        `    official timetable: ${doc.title} (${doc.publishedAt ?? '?'}) → ${timetable.length} lines`
      );
      return { timetable, doc };
    } catch (err) {
      lastError = err;
      console.log(`    official timetable: ${doc.url} failed (${err}) — trying the next revision`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('hefei: official timetable unavailable');
}

/**
 * Parse the published distance tariff out of the fare-policy article.
 *
 * The article is plain prose, e.g. "起步价 2 元可乘 8 公里；乘坐 8 公里以上，
 * 14 公里 ( 含 ) 以内的 3 元；…；乘坐 29 公里以上的，每增加 9 公里，加收 1 元。"
 */
export function parseFarePolicy(text: string): OfficialFarePolicy {
  const start = /起步价\s*(\d+)\s*元(?:可乘|可乘坐)\s*(\d+)\s*公里/.exec(text);
  if (!start) throw new Error('hefei: fare policy text does not carry a 起步价 clause');

  const steps: { upToKm: number; yuan: number }[] = [
    { upToKm: Number(start[2]), yuan: Number(start[1]) }
  ];
  const stepRe =
    /乘坐\s*(\d+)\s*公里以上\s*[，,]\s*(\d+)\s*公里\s*\(\s*含\s*\)\s*以内的\s*(\d+)\s*元/g;
  for (const m of text.matchAll(stepRe)) {
    steps.push({ upToKm: Number(m[2]), yuan: Number(m[3]) });
  }
  const tail =
    /乘坐\s*(\d+)\s*公里以上的\s*[，,]\s*每增加\s*(\d+)\s*公里\s*[，,]\s*加收\s*(\d+)\s*元/.exec(
      text
    );
  if (!tail) throw new Error('hefei: fare policy text does not carry the 29 km tail clause');

  const tailKm = Number(tail[2]);
  const tailYuan = Number(tail[3]);
  if (tailYuan !== 1) {
    throw new Error(`hefei: unexpected tail step (${tailKm} km per ${tailYuan} yuan)`);
  }
  return { steps, tailKm, tailYuan, text };
}

/** Fetch and parse the official fare policy. */
export async function fetchOfficialFarePolicy(): Promise<{
  fare: OfficialFarePolicy;
  doc: DisclosureDoc;
}> {
  const doc = await findDisclosureDoc(CAT_FARE_PRICE, /票价/);
  if (!doc) throw new Error('hefei: no 票价 document found on the disclosure platform');
  const html = await fetchGovText(doc.url, { referer: HEFEI_GOV_COLUMN });
  const text = textOf(html);
  const fare = parseFarePolicy(text);

  // The published ladder must agree with the encoded one, otherwise the tariff
  // changed and the adapter has to be updated deliberately.
  const encoded = FARE_LADDER.map((s) => `${s.upToKm}:${s.yuan}`).join(',');
  const parsed = fare.steps.map((s) => `${s.upToKm}:${s.yuan}`).join(',');
  if (encoded !== parsed) {
    throw new Error(
      `hefei: published tariff (${parsed}) differs from the encoded ladder (${encoded}) — ` +
        'update FARE_LADDER in ./lines.ts'
    );
  }
  if (fare.tailKm !== FARE_LADDER_TAIL_KM) {
    throw new Error(
      `hefei: published tail step (${fare.tailKm} km) differs from the encoded one ` +
        `(${FARE_LADDER_TAIL_KM} km) — update FARE_LADDER_TAIL_KM in ./lines.ts`
    );
  }
  console.log(`    official tariff: ${fare.steps.length} steps + ${fare.tailKm} km/yuan tail`);
  return { fare, doc };
}

/**
 * Resolve the official operating network map (PNG) and the not-yet-open
 * stations it marks.
 *
 * The map is a raster image: the repository does not OCR it (see the
 * cn-jinan / cn-urumqi notes), so only its URL and the three 暂未开通
 * stations are taken from it — the latter are transcribed in `./lines.ts` with
 * this document as their citation.
 */
export async function fetchOfficialNetworkMap(): Promise<{
  url?: string;
  doc?: DisclosureDoc;
}> {
  const doc = await findDisclosureDoc(CAT_OPERATING_LINES, /^运营线路$/);
  if (!doc) return {};
  try {
    const html = await fetchGovText(doc.url, { referer: HEFEI_GOV_COLUMN });
    const png = /<img[^>]+src="([^"]+\.png)"/i.exec(html)?.[1];
    if (!png) return { doc };
    return { doc, url: png.startsWith('http') ? png : `https://www.hefei.gov.cn${png}` };
  } catch {
    return { doc };
  }
}

/**
 * Fetch every source the normalizer needs.
 *
 * Minimum counts guard against a truncated feed: the operator runs 8 lines
 * with 215 line-stop rows over 195 stations today, and the official table
 * carries one row per operating line.
 */
export async function fetchHefeiSources(): Promise<HefeiSources> {
  console.log('  fetch AMap subway 3401_drw_hefei.json');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    ${amap.l?.length ?? 0} lines, ${amapStops} line-stop rows`);
  if ((amap.l?.length ?? 0) < 8) {
    throw new Error(
      `hefei: AMap subway looks truncated (${amap.l?.length ?? 0} lines, expected >= 8)`
    );
  }
  if (amapStops < 200) {
    throw new Error(
      `hefei: AMap subway looks truncated (${amapStops} line-stop rows, expected >= 200)`
    );
  }

  console.log('  fetch official 首末班车时间及行车间隔');
  const { timetable, doc: timetableDoc } = await fetchOfficialTimetable();
  if (timetable.length < 8) {
    throw new Error(
      `hefei: official timetable covers only ${timetable.length} lines (expected >= 8)`
    );
  }

  console.log('  fetch official 票价信息及优惠政策');
  const { fare, doc: fareDoc } = await fetchOfficialFarePolicy();

  console.log('  fetch official 运营线路 (network map)');
  const { url: networkMapUrl, doc: networkMapDoc } = await fetchOfficialNetworkMap();

  return {
    amap,
    timetable,
    timetableDoc,
    fare,
    fareDoc,
    networkMapUrl,
    networkMapDoc
  };
}

/** The band-aware times of one station/direction, as the operator published them. */
export type OfficialStationBandTimes = BandTimes;
