import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

/**
 * Macau LRT (澳門輕軌) sources — everything machine-read from official pages
 * plus AMap for coordinates. No hand-maintained station/line/fare tables.
 *
 * - AMap subway `8200_drw_aomen.json` — GCJ-02 coordinates only.
 * - mlm.com.mo `/tc/route.html` + `/en/route.html` — line colors, station
 *   order (zh/en), timetable sheet codes, service hours.
 * - mlm.com.mo ticket pages — fare tiers and sea-crossing counting rules.
 */
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/8200_drw_aomen.json';
export const MLM_BASE = 'https://www.mlm.com.mo';
export const MLM_ROUTE_TC = `${MLM_BASE}/tc/route.html`;
export const MLM_ROUTE_EN = `${MLM_BASE}/en/route.html`;
export const MLM_TICKET_TC = `${MLM_BASE}/tc/general_ticket.html`;
export const MLM_TICKET_EN = `${MLM_BASE}/en/general_ticket.html`;
export const MLM_TICKET_CONCESSION_TC = `${MLM_BASE}/tc/concessionary_ticket.html`;
export const MLM_TICKET_CONCESSION_EN = `${MLM_BASE}/en/concessionary_ticket.html`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders(),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// AMap (coordinates only)
// ---------------------------------------------------------------------------

export interface AmapStation {
  sid: string;
  zh: string;
  zhHant: string;
  en: string;
  lon: number;
  lat: number;
  poiid?: string;
  lineNames: string[];
}

export interface AmapSubwayDoc {
  stations: AmapStation[];
}

export function parseAmapSubway(text: string): AmapSubwayDoc {
  const doc = JSON.parse(text) as {
    l?: {
      ln?: string;
      st?: {
        n?: string;
        sid?: string;
        sl?: string;
        poiid?: string;
        multilang?: { n?: { en?: string; 'zh-Hant-HK'?: string } };
      }[];
    }[];
  };

  const stationsById = new Map<string, AmapStation>();
  for (const line of doc.l ?? []) {
    const name = line.ln ?? '';
    for (const st of line.st ?? []) {
      const sl = st.sl;
      const sid = st.sid;
      if (!sl || !sid) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const zh = st.multilang?.n?.['zh-Hant-HK'] || st.n || '';
      const en = st.multilang?.n?.en || zh;
      const existing = stationsById.get(sid);
      if (existing) {
        if (!existing.lineNames.includes(name)) existing.lineNames.push(name);
        continue;
      }
      stationsById.set(sid, {
        sid,
        zh: st.n ?? zh,
        zhHant: zh,
        en,
        lon,
        lat,
        poiid: st.poiid,
        lineNames: [name]
      });
    }
  }
  return { stations: [...stationsById.values()] };
}

// ---------------------------------------------------------------------------
// Official route page parsers
// ---------------------------------------------------------------------------

/** One operating line as published on the route page. */
export interface MlmLine {
  /** Stable key derived from the JS array name (taipa / spv / hengqin). */
  key: string;
  zh: string;
  en: string;
  /** Official brand colour `#rrggbb` from the route-page legend. */
  color: string;
  /** Official station names, terminus-first order (transfer notes stripped). */
  stationsZh: string[];
  stationsEn: string[];
  service: {
    weekdays: string;
    weekend: string;
    frequency: string;
    journeyMinutes: number | null;
  };
}

export interface MlmStationMeta {
  zh: string;
  en: string;
  /** Timetable image code (BAR, TFT, …) when the route page publishes a sheet. */
  ttCode?: string;
  ttImageUrl?: string;
  lines: string[];
}

export interface MlmFareTier {
  maxStations: number;
  /** Adult single-journey token. */
  single: number;
  /** General electronic prepaid card. */
  card: number;
  /** Concessionary single (child / elderly / disabled without card). */
  concessionSingle: number;
  /** Student card. */
  studentCard: number;
}

export interface MlmSources {
  amap: AmapSubwayDoc;
  lines: MlmLine[];
  stations: MlmStationMeta[];
  fareTiers: MlmFareTier[];
  /** Sea-crossing edges count as 2 stations (official Chinese/English pairs). */
  seaCrossingPairs: [string, string][];
  /** Station counted only as a journey endpoint (協和醫院). */
  endpointOnlyStations: string[];
  timetableVersion: string;
  timetableImages: string[];
}

/** Strip 站 / transfer annotations from a published station label. */
export function cleanStationName(label: string): string {
  return label
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim()
    .replace(/站$/, '')
    .trim();
}

/** `var taipa_line = [ { text: "媽閣站" }, … ]` */
function parseLineStationArray(html: string, varName: string): string[] {
  const m = new RegExp(`var\\s+${varName}\\s*=\\s*\\[(.*?)\\];`, 's').exec(html);
  if (!m) return [];
  return [...m[1]!.matchAll(/text:\s*"([^"]+)"/g)].map((x) => cleanStationName(x[1]!));
}

/** Legend spans: `<span style="background-color: #93d50a;">氹仔線</span>` */
function parseColorLegend(html: string): { zh: string; color: string }[] {
  const out: { zh: string; color: string }[] = [];
  for (const m of html.matchAll(
    /background-color:\s*(#[0-9A-Fa-f]{3,8})[^>]*>\s*([^<]{1,40})\s*<\/span>/g
  )) {
    const color = m[1]!.toUpperCase();
    const name = m[2]!.trim();
    if (!name) continue;
    if (!/線$|线$|Line$/i.test(name)) continue;
    out.push({ zh: name, color });
  }
  return out;
}

/** `var …_line` keys on the route page, in page order. */
const LINE_VARS = [
  { varName: 'taipa_line', key: 'taipa' },
  { varName: 'spv_line', key: 'spv' },
  { varName: 'Hengqin_line', key: 'hengqin' }
] as const;

/** Map a JS var key to the legend label (zh) by station overlap / order. */
function matchLegend(
  key: string,
  _stations: string[],
  legend: { zh: string; color: string }[]
): { zh: string; color: string } {
  // Deterministic label fragments per line key (zh and en legends).
  const stems: Record<string, string[]> = {
    taipa: ['氹仔', 'taipa'],
    spv: ['石排灣', '石排湾', 'seac pai van'],
    hengqin: ['橫琴', '横琴', 'hengqin']
  };
  const needles = (stems[key] ?? [key]).map((n) => n.toLowerCase());
  for (const item of legend) {
    const label = item.zh.toLowerCase();
    if (needles.some((n) => label.includes(n))) return { zh: item.zh, color: item.color };
  }
  return { zh: key, color: '#666666' };
}

function parseServiceBlocks(html: string): Record<string, MlmLine['service']> {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ');
  const decoded = text.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  const out: Record<string, MlmLine['service']> = {};
  const _re =
    /(?:(氹仔線|石排灣線|橫琴線|Taipa Line|Seac Pai Van Line|Hengqin Line))\s*[：:]?\s*星期一至四[：:]\s*([0-9]{2}:[0-9]{2}\s*-\s*[0-9]{2}:[0-9]{2})\s*星期五[^：:]*[：:]\s*([0-9]{2}:[0-9]{2}\s*-\s*[0-9]{2}:[0-9]{2})\s*班次安排[：:]\s*([^行]+?)行車時間[：:]\s*全程約\s*([0-9]+)\s*分鐘/;

  const alt =
    /(氹仔線|石排灣線|橫琴線)[\s\S]{0,20}?星期一至四[：:]\s*([0-9:]+\s*-\s*[0-9:]+)[\s\S]{0,40}?星期五[^：:]*[：:]\s*([0-9:]+\s*-\s*[0-9:]+)[\s\S]{0,40}?班次安排[：:]\s*([^行]{0,40})行車時間[：:]\s*全程約\s*([0-9]+)\s*分鐘/g;

  for (const m of decoded.matchAll(alt)) {
    const key =
      m[1] === '氹仔線'
        ? 'taipa'
        : m[1] === '石排灣線'
          ? 'spv'
          : m[1] === '橫琴線'
            ? 'hengqin'
            : '';
    if (!key) continue;
    out[key] = {
      weekdays: m[2]!.replace(/\s+/g, ''),
      weekend: m[3]!.replace(/\s+/g, ''),
      frequency: m[4]!.trim(),
      journeyMinutes: Number(m[5])
    };
  }

  // English fallback
  if (Object.keys(out).length < 3) {
    const enAlt =
      /(Taipa Line|Seac Pai Van Line|Hengqin Line)[\s\S]{0,40}?Monday to Thursday[：:]\s*([0-9:]+\s*-\s*[0-9:]+)[\s\S]{0,60}?Friday[^：:]*[：:]\s*([0-9:]+\s*-\s*[0-9:]+)[\s\S]{0,80}?Frequency[：:]\s*([^J]{0,50})Journey[\s\S]{0,20}?([0-9]+)\s*minute/gi;
    for (const m of decoded.matchAll(enAlt)) {
      const key = m[1]!.toLowerCase().includes('taipa')
        ? 'taipa'
        : m[1]!.toLowerCase().includes('seac')
          ? 'spv'
          : 'hengqin';
      out[key] = {
        weekdays: m[2]!.replace(/\s+/g, ''),
        weekend: m[3]!.replace(/\s+/g, ''),
        frequency: m[4]!.trim(),
        journeyMinutes: Number(m[5])
      };
    }
  }
  return out;
}

/**
 * `data-image="/images/stations/TimeTable/2026_09/TT_BAR_2026_09_V2.jpg"`
 * `data-title="媽閣站"` → station zh + TT code + URL.
 */
function parseTimetableSheets(html: string): {
  version: string;
  images: string[];
  byStationZh: Map<string, { code: string; url: string }>;
} {
  const version = /\/images\/stations\/TimeTable\/([^/]+)\//.exec(html)?.[1] ?? 'unknown';
  const images: string[] = [];
  const byStationZh = new Map<string, { code: string; url: string }>();
  for (const m of html.matchAll(/data-image="([^"]+)"\s+data-title="([^"]+)"/g)) {
    const url = m[1]!;
    const title = cleanStationName(m[2]!);
    images.push(url);
    const code = /TT_([A-Z_]+)_/.exec(url)?.[1];
    if (!code || !title) continue;
    // A station may have several sheets (per line/direction). Prefer the
    // Taipa-line sheet (*_V2.jpg) over shuttle-line sheets when both exist.
    const prev = byStationZh.get(title);
    const preferNew =
      !prev ||
      (/_V2\.jpg$/.test(url) && !/_V2\.jpg$/.test(prev.url)) ||
      (/_V2\.jpg$/.test(url) === /_V2\.jpg$/.test(prev.url) && code.length < prev.code.length);
    if (preferNew) byStationZh.set(title, { code, url });
  }
  return { version, images, byStationZh };
}

// ---------------------------------------------------------------------------
// Official ticket page parsers
// ---------------------------------------------------------------------------

/**
 * Fare ladders appear as paired `ticket_box` money cells and
 * `少於或等於N站` / `N stations or less` station-count labels.
 * The general page has two ladders (single, card); the concessionary page
 * has two more (concession single, student card). All share the same
 * station-count breakpoints.
 */
function parseMoneyLadder(html: string): number[] {
  const money: number[] = [];
  for (const m of html.matchAll(
    /ticket_box[^>]*>\s*(?:澳門元|MOP\s*\$)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:元)?\s*</gi
  )) {
    money.push(Number(m[1]));
  }
  return money;
}

function parseStationBreakpoints(html: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const _m of html.matchAll(/(\d+)\s*(?:stations or less|站)/gi)) {
    // Chinese: 少於或等於三站 — need numeric map
  }
  for (const m of html.matchAll(/(\d+)\s*stations or less/gi)) {
    const n = Number(m[1]);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  // Chinese numerals
  const cn: Record<string, number> = { 三: 3, 六: 6, 九: 9, 十二: 12, 二: 2, 四: 4 };
  for (const m of html.matchAll(/少於或等於([三四五六七八九十]+)站/g)) {
    const n = cn[m[1]!];
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Sea-crossing pairs from the fare notes (zh and en). */
function parseSeaCrossing(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  // 媽閣站往來海洋站 or 橫琴站往來蓮花站
  for (const m of text.matchAll(
    /([\\u4e00-\\u9fff]{1,6})站?\s*往來\s*([\\u4e00-\\u9fff]{1,6})站/g
  )) {
    pairs.push([cleanStationName(m[1]!), cleanStationName(m[2]!)]);
  }
  // between Barra and Ocean Station / between Hengqin Station and Lotus Station
  for (const m of text.matchAll(
    /between\s+([A-Za-z ]+?)\s+Station\s+and\s+([A-Za-z ]+?)\s+Station/gi
  )) {
    pairs.push([m[1]!.trim(), m[2]!.trim()]);
  }
  // Dedup by sorted pair
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const [a, b] of pairs) {
    const k = [a, b].sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([a, b]);
  }
  return out;
}

function parseEndpointOnly(text: string): string[] {
  // 「以石排灣站或協和醫院站作為旅程起點或終點時，協和醫院站均視作一站計算」
  const out: string[] = [];
  const m = /([\\u4e00-\\u9fff]{1,6})站均視作一站計算/.exec(text);
  if (m) out.push(cleanStationName(m[1]!));
  const en = /([A-Za-z ]+?) Station is counted as a stop/.exec(text);
  if (en) out.push(en[1]!.trim());
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function fetchMlmSources(): Promise<MlmSources> {
  console.log('  fetch AMap Macau subway 8200');
  const amap = parseAmapSubway(await getText(AMAP_SUBWAY));

  console.log('  fetch MLM route pages (tc + en)');
  const routeTc = await getText(MLM_ROUTE_TC);
  const routeEn = await getText(MLM_ROUTE_EN);

  const legendTc = parseColorLegend(routeTc);
  const legendEn = parseColorLegend(routeEn);
  const service = parseServiceBlocks(routeTc);
  const sheetsTc = parseTimetableSheets(routeTc);

  const lines: MlmLine[] = [];
  for (const { varName, key } of LINE_VARS) {
    const stationsZh = parseLineStationArray(routeTc, varName);
    const stationsEnRaw = parseLineStationArray(routeEn, varName);
    const stationsEn = stationsEnRaw.map((n) =>
      n
        .replace(/\s*\(Transfer to[^)]*\)/i, '')
        .replace(/\s*（轉乘[^）]*）/g, '')
        .trim()
    );
    if (stationsZh.length < 2) continue;
    const legend = matchLegend(key, stationsZh, legendTc);
    const legendEnItem = matchLegend(key, stationsEn, legendEn);
    lines.push({
      key,
      zh: legend.zh,
      en: legendEnItem.zh,
      color: legend.color,
      stationsZh,
      stationsEn,
      service: service[key] ?? {
        weekdays: '',
        weekend: '',
        frequency: '',
        journeyMinutes: null
      }
    });
  }

  // Station metadata: union of all lines
  const stations: MlmStationMeta[] = [];
  const byZh = new Map<string, MlmStationMeta>();
  for (const line of lines) {
    for (let i = 0; i < line.stationsZh.length; i++) {
      const zh = line.stationsZh[i]!;
      const en = line.stationsEn[i] ?? zh;
      let meta = byZh.get(zh);
      if (!meta) {
        const sheet = sheetsTc.byStationZh.get(zh);
        meta = {
          zh,
          en,
          ttCode: sheet?.code,
          ttImageUrl: sheet?.url,
          lines: []
        };
        byZh.set(zh, meta);
        stations.push(meta);
      }
      if (!meta.lines.includes(line.key)) meta.lines.push(line.key);
      if (!meta.en || meta.en === meta.zh) meta.en = en;
    }
  }

  console.log('  fetch MLM ticket pages');
  const ticketTc = await getText(MLM_TICKET_TC);
  const ticketEn = await getText(MLM_TICKET_EN);
  const concTc = await getText(MLM_TICKET_CONCESSION_TC);
  const concEn = await getText(MLM_TICKET_CONCESSION_EN);

  const moneyGeneral = parseMoneyLadder(ticketTc);
  const moneyConc = parseMoneyLadder(concTc);
  const moneyGeneralEn = parseMoneyLadder(ticketEn);
  const moneyConcEn = parseMoneyLadder(concEn);
  const breaks = [
    ...new Set([
      ...parseStationBreakpoints(ticketTc),
      ...parseStationBreakpoints(ticketEn),
      ...parseStationBreakpoints(concTc),
      ...parseStationBreakpoints(concEn)
    ])
  ].sort((a, b) => a - b);

  // Ladders are [single, card, single, card] on general page
  // and [concessionSingle, studentCard, …] on concessionary page.
  const singles = moneyGeneral.filter((_, i) => i % 2 === 0);
  const cards = moneyGeneral.filter((_, i) => i % 2 === 1);
  const concSingles = moneyConc.filter((_, i) => i % 2 === 0);
  const studentCards = moneyConc.filter((_, i) => i % 2 === 1);
  // EN fallback if TC parse is empty
  const singlesEn = moneyGeneralEn.filter((_, i) => i % 2 === 0);
  const cardsEn = moneyGeneralEn.filter((_, i) => i % 2 === 1);

  const fareTiers: MlmFareTier[] = breaks.map((maxStations, i) => ({
    maxStations,
    single: singles[i] ?? singlesEn[i] ?? 0,
    card: cards[i] ?? cardsEn[i] ?? 0,
    concessionSingle: concSingles[i] ?? moneyConcEn.filter((_, j) => j % 2 === 0)[i] ?? 0,
    studentCard: studentCards[i] ?? moneyConcEn.filter((_, j) => j % 2 === 1)[i] ?? 0
  }));

  const ticketText = ticketTc + ticketEn;
  const seaCrossingPairs = parseSeaCrossing(ticketText);
  const endpointOnlyStations = parseEndpointOnly(ticketText);

  return {
    amap,
    lines,
    stations,
    fareTiers,
    seaCrossingPairs,
    endpointOnlyStations,
    timetableVersion: sheetsTc.version,
    timetableImages: sheetsTc.images
  };
}
