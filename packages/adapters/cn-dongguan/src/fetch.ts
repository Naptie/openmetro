import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { textOf } from './timetables.js';

export const OPERATOR = 'https://www.dggdjt.com/';
export const AMAP_URL = 'https://webapi.amap.com/subway/data/4419_drw_dongguan.json';
export const SERVICE_TIME_URL = new URL('node/121.htmx', OPERATOR).href;

export interface AmapStation {
  n: string;
  sp?: string;
  sl?: string;
  p?: string;
  si?: string;
  poiid?: string;
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  ln: string;
  li?: string;
  cl?: string;
  st: AmapStation[];
}

export interface AmapDocument {
  l: AmapLine[];
}

export interface DongguanSources {
  amap: AmapDocument;
  timetableHtml: string;
  timetableUrl: string;
}

export async function getText(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({
          // Without a Referer the operator's subpages silently time out.
          Referer: OPERATOR,
          'X-Requested-With': 'XMLHttpRequest'
        }),
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
      return await response.text();
    } catch (err) {
      last = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Failed to fetch ${url}`, { cause: last });
}

function timetableArticles(index: string): { url: string; date: string }[] {
  const articles = new Map<string, string>();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  for (const a of index.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/服务时间|首末班车|运营时间/.test(a[0]) || !/^\/info\/\d+\.htmx$/.test(a[1]!)) continue;
    const end = index.indexOf('</li>', a.index);
    const entry = end < 0 ? a[0] : index.slice(a.index, end);
    const date = /\d{4}-\d{2}-\d{2}/.exec(textOf(entry))?.[0] ?? '';
    if (date <= today) articles.set(new URL(a[1]!, OPERATOR).href, date);
  }
  const candidates = [...articles].map(([url, date]) => ({ url, date }));
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  if (!candidates.length) throw new Error('Operator service-time index has no timetable article');
  if (candidates.length > 1 && candidates[0]!.date === candidates[1]!.date)
    throw new Error('Ambiguous operator timetable articles');
  return candidates;
}

/** Publication date takes precedence over page order (which can include pinned articles). */
export function timetableArticleUrl(index: string): string {
  return timetableArticles(index)[0]!.url;
}

export async function fetchDongguanSources(): Promise<DongguanSources> {
  const [amapText, index] = await Promise.all([getText(AMAP_URL), getText(SERVICE_TIME_URL)]);
  const amap = JSON.parse(amapText) as AmapDocument;
  if (!Array.isArray(amap.l) || !['1号线', '2号线'].every((n) => amap.l.some((l) => l.ln === n))) {
    throw new Error('AMap Dongguan feed is missing an operating line');
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  for (const { url: timetableUrl } of timetableArticles(index)) {
    const timetableHtml = await getText(timetableUrl);
    const effective = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s*起/.exec(textOf(timetableHtml));
    if (effective) {
      const date = `${effective[1]}-${effective[2]!.padStart(2, '0')}-${effective[3]!.padStart(2, '0')}`;
      if (date > today) continue;
    }
    console.log(`  operator timetable: ${timetableUrl}`);
    return { amap, timetableUrl, timetableHtml };
  }
  throw new Error('No operator timetable is effective yet');
}

export interface OfficialStation {
  id: number;
  name: string;
  removed: number;
  seq: number;
}

interface OfficialLine {
  id: number;
  name: string;
  stations: OfficialStation[];
}

export async function fetchFareStations(): Promise<OfficialStation[]> {
  const stations = new Map<number, OfficialStation>();
  for (const id of [1, 2]) {
    const raw = JSON.parse(await getText(`${OPERATOR}ext/line.htmx?lineId=${id}`)) as {
      info?: { success?: boolean };
      data?: OfficialLine[];
    };
    if (!raw.info?.success || !Array.isArray(raw.data))
      throw new Error('Invalid operator line response');
    for (const line of raw.data) {
      if (line.id !== id || !Array.isArray(line.stations))
        throw new Error('Unexpected operator line id');
      for (const station of line.stations) {
        if (!station.removed) stations.set(station.id, station);
      }
    }
  }
  if (stations.size < 15) throw new Error('Operator fare station catalog is incomplete');
  return [...stations.values()];
}
