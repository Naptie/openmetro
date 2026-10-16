import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { fetchTaiwanServiceCalendar } from '@openmetro/taiwan-shared';
import { geocodeRailStation } from './geocode.js';

export const ORIGIN = 'https://www.krtc.com.tw';
export const PHOTON = 'https://photon.komoot.io/api/';
export interface Option {
  value: string;
  code: string;
  name: string;
}
export interface ServiceTime {
  destination?: string;
  direction: 'linear' | 'loop_outer' | 'loop_inner';
  first: string[];
  last: string[];
  days?: { label: string; first: string; last: string }[];
}
export interface StationMap {
  zh: string;
  en: string;
  location: { lon: number; lat: number; crs: 'wgs84' };
}
export interface SourceStation extends StationMap {
  key: string;
  codes: string[];
  section: string;
  url: string;
  osmId: string;
}
export interface Quote {
  from: string;
  to: string;
  fare: number;
  seconds: number;
}
export interface KaohsiungSources {
  stations: SourceStation[];
  lines: { code: string; stops: string[] }[];
  timetables: { code: string; rows: ServiceTime[] }[];
  lrtEdges: { from: string; to: string; seconds: number }[];
  quotes: Quote[];
  serviceCalendar?: Awaited<ReturnType<typeof fetchTaiwanServiceCalendar>>['calendar'];
  calendarSource?: Awaited<ReturnType<typeof fetchTaiwanServiceCalendar>>['source'];
}
export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
export function parseOptions(html: string): Option[] {
  return [...html.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi)]
    .map((m) => {
      const label = text(m[2]!);
      const match = label.match(/^([ROC][A-Z]?\d+[A-Z]?)\s+(.+)$/);
      return match ? { value: text(m[1]!), code: match[1]!, name: match[2]! } : undefined;
    })
    .filter((v): v is Option => !!v);
}
export function parseStationMap(html: string): StationMap {
  const title = html.match(/<div class="tit">[\s\S]*?<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/);
  const iframe = html.match(/<iframe\b[^>]*src="([^"]*google[^"]+)"/i)?.[1];
  const pair = iframe?.match(/!2d(-?[\d.]+)!3d(-?[\d.]+)/);
  if (!title || !pair || !/[a-z]/i.test(text(title[2]!)))
    throw new Error('Missing KRTC station map/identity');
  return {
    zh: text(title[1]!),
    en: text(title[2]!),
    location: { lon: Number(pair[1]), lat: Number(pair[2]), crs: 'wgs84' }
  };
}
export function parseTimetable(html: string, loop: boolean): ServiceTime[] {
  const body =
    html.match(/<!-- (?:輕軌)?時刻表 -->([\s\S]*?)<!-- End (?:輕軌)?時刻表 -->/)?.[1] ?? html;
  const rows: ServiceTime[] = [];
  let current: ServiceTime | undefined;
  let days: { label: string; first: string; last: string }[] = [];
  const flush = () => {
    if (!current) return;
    const get = (day: number, field: 'first' | 'last') => {
      const label = loop
        ? day >= 5
          ? '假日'
          : '平日'
        : day === 4
          ? '假日前一日'
          : day === 5
            ? '週六'
            : day === 6
              ? '週日'
              : '平日';
      const matches = days.filter((d) => d.label === label);
      const row = matches[0];
      if (!row || matches.length !== 1) throw new Error(`KRTC missing/duplicate day type ${label}`);
      return row[field];
    };
    current.first = Array.from({ length: 7 }, (_, i) => get(i, 'first'));
    current.last = Array.from({ length: 7 }, (_, i) => get(i, 'last'));
    current.days = days;
    rows.push(current);
    days = [];
  };
  for (const m of body.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi)) {
    const label = text(m[1]!.match(/<dt[^>]*>([\s\S]*?)<\/dt>/)?.[1] ?? '');
    const first = m[1]!.match(/首班車<\/span>\s*(\d{2}:\d{2})/)?.[1];
    const last = m[1]!.match(/末班車<\/span>\s*(\d{2}:\d{2})/)?.[1];
    if (first && last) {
      days.push({ label, first, last });
      continue;
    }
    if ((loop && /順行|逆行/.test(label)) || (!loop && /上行|下行/.test(label))) {
      flush();
      current = {
        destination: loop ? undefined : label.match(/往\s*(.+?)[）)]/)?.[1]?.trim(),
        direction: loop ? (label.includes('逆行') ? 'loop_inner' : 'loop_outer') : 'linear',
        first: [],
        last: []
      };
    }
  }
  flush();
  if (!rows.length) throw new Error('Missing KRTC timetable');
  return rows;
}
export function parseFare(html: string): { fare: number; seconds: number } {
  const clean = text(html);
  const fare = Number(clean.match(/單程票\/普卡\s*(\d+)元/)?.[1]);
  const minutes = Number(clean.match(/行駛時間\s*約?\s*(\d+)\s*分/)?.[1]);
  if (!(fare > 0) || !(minutes > 0))
    throw new Error('Invalid KRTC planner quote (zero/missing fare or time)');
  return { fare, seconds: minutes * 60 };
}
export function parseLrtEdges(html: string): KaohsiungSources['lrtEdges'] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new Error('Missing KRTC light rail travel matrix');
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => text(c[1]!))
  );
  const codes = rows.map((r, i) => r[i]?.match(/^(C\d+[A-Z]?)/)?.[1]);
  if (codes.length < 3 || codes[0] !== codes.at(-1) || codes.some((c) => !c))
    throw new Error('KRTC light rail matrix diagonal changed');
  return rows.slice(0, -1).flatMap((row, i) => {
    const forward = Number(row[i + 1]);
    const reverse = Number(rows[i + 1]![i]);
    if (!(forward > 0 && reverse > 0)) throw new Error('Missing directional light rail runtime');
    return [
      { from: codes[i]!, to: codes[i + 1]!, seconds: forward * 60 },
      { from: codes[i + 1]!, to: codes[i]!, seconds: reverse * 60 }
    ];
  });
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}
async function getText(url: string): Promise<string> {
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders(),
        signal: AbortSignal.timeout(45000)
      });
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return await res.text();
    } catch (e) {
      error = e;
      await Bun.sleep(300 * (attempt + 1));
    }
  }
  throw error;
}
export async function fetchKaohsiung(opts: {
  fares: boolean;
  cacheDir: string;
}): Promise<KaohsiungSources> {
  const [red, orange, lrt, metroGuide, lrtGuide, home, matrix, calendar] = await Promise.all([
    getText(`${ORIGIN}/Home/GetLineList?id=R`),
    getText(`${ORIGIN}/Home/GetLineList?id=O`),
    getText(`${ORIGIN}/KLRT/first_and_last_train`),
    getText(`${ORIGIN}/Guide/station_guide`),
    getText(`${ORIGIN}/KLRT/station_guide`),
    getText(ORIGIN),
    getText(`${ORIGIN}/KLRT/time_between_train`),
    fetchTaiwanServiceCalendar()
  ]);
  const lines = [
    { code: 'R', stops: parseOptions(red).map((s) => s.code) },
    { code: 'O', stops: parseOptions(orange).map((s) => s.code) },
    { code: 'C', stops: parseOptions(lrt).map((s) => s.code) }
  ];
  if (lines.some((l) => l.stops.length < 2)) throw new Error('Missing KRTC line stops');
  const entries = new Map<string, { id: string; codes: string[]; section: string }>();
  for (const [section, html] of [
    ['Guide', metroGuide],
    ['KLRT', lrtGuide]
  ]) {
    const regex = new RegExp(
      `<a href="/${section}/station_info\\?id=([^"]+)"[^>]*>([\\s\\S]*?)</a>`,
      'g'
    );
    for (const m of html!.matchAll(regex)) {
      const codes = [...m[2]!.matchAll(/<em[^>]*>([^<]+)<\/em>/g)].map((c) => text(c[1]!));
      if (codes.length) entries.set(m[1]!, { id: m[1]!, codes, section: section! });
    }
  }
  console.log(`  KRTC: resolving ${entries.size} station identities and rail coordinates`);
  let resolved = 0;
  // Avoid bursts against the shared geocoder while preserving every identity check.
  const stations = await mapLimit(
    [...entries.values()],
    async (e) => {
      const url = `${ORIGIN}/${e.section}/station_map?id=${e.id}`;
      const info = parseStationMap(await getText(url));
      const coords = await geocodeRailStation(info, e.codes, e.section === 'KLRT', getText);
      if (++resolved % 20 === 0) console.log(`  KRTC coordinates ${resolved}/${entries.size}`);
      return { ...info, ...coords, key: e.codes[0]!, codes: e.codes, section: e.section, url };
    },
    1
  );
  const timetables = await mapLimit(
    lines.flatMap((l) => l.stops),
    async (code) => ({
      code,
      rows: parseTimetable(
        await getText(
          `${ORIGIN}/${code.startsWith('C') ? 'KLRT' : 'Guide'}/first_and_last_train?${new URLSearchParams({ KRTCSLLine: code[0]!, KRTCStation: code })}`
        ),
        code.startsWith('C')
      )
    })
  );
  const options = parseOptions(
    home.match(/<select[^>]*id="KRTCStartStation"[\s\S]*?<\/select>/)?.[0] ?? ''
  );
  const plannerNames = new Map(options.map((o) => [o.code, o.value]));
  // O5 is the same physical station as R10; the homepage lists it once.
  for (const s of stations)
    for (const code of s.codes) {
      if (!plannerNames.has(code)) {
        const hit = s.codes.map((c) => plannerNames.get(c)).find(Boolean);
        if (hit) plannerNames.set(code, hit);
      }
    }
  const query = async (from: string, to: string): Promise<Quote> => {
    const loop = from.startsWith('C');
    const a = loop ? from : plannerNames.get(from);
    const b = loop ? to : plannerNames.get(to);
    if (!a || !b) throw new Error(`Missing KRTC planner identity ${from}/${to}`);
    const url = `${ORIGIN}/Home/${loop ? 'GetLRTPriceTime' : 'GetMTRLRT'}?${new URLSearchParams({ stype: loop ? '2' : '1', cardtype: '', stationname1: a, stationname2: b })}`;
    const cache = join(opts.cacheDir, `${createHash('sha256').update(url).digest('hex')}.html`);
    let raw: string | undefined;
    try {
      if (Date.now() - (await stat(cache)).mtimeMs < 86400000) raw = await readFile(cache, 'utf8');
    } catch {}
    const quote = parseFare(raw ?? (await getText(url)));
    if (!raw) {
      await mkdir(opts.cacheDir, { recursive: true });
      await writeFile(
        cache,
        `<em>行駛時間</em>${quote.seconds / 60}分<em>單程票/普卡</em>${quote.fare}元`
      );
    }
    return { from, to, ...quote };
  };
  const pairs = new Map<string, [string, string]>();
  for (const line of lines.filter((l) => l.code !== 'C'))
    for (let i = 0; i < line.stops.length - 1; i++)
      pairs.set(`${line.stops[i]}|${line.stops[i + 1]}`, [line.stops[i]!, line.stops[i + 1]!]);
  // Anchor each direction independently: summing rounded adjacent quotes
  // overstates long journeys by many minutes.
  for (const line of lines.filter((l) => l.code !== 'C'))
    for (const from of [line.stops[0]!, line.stops.at(-1)!])
      for (const to of line.stops) if (from !== to) pairs.set(`${from}|${to}`, [from, to]);
  if (opts.fares) {
    for (const section of ['Guide', 'KLRT']) {
      const codes = stations.filter((s) => s.section === section).map((s) => s.key);
      for (let i = 0; i < codes.length; i++)
        for (let j = i + 1; j < codes.length; j++)
          pairs.set(`${codes[i]}|${codes[j]}`, [codes[i]!, codes[j]!]);
    }
  }
  console.log(
    `  KRTC: ${stations.length} stations; ${pairs.size} planner pairs (24-hour scratch cache)`
  );
  let completed = 0;
  const quotes = await mapLimit([...pairs.values()], async ([a, b]) => {
    const quote = await query(a, b);
    completed++;
    if (completed % 100 === 0) console.log(`  KRTC quotes ${completed}/${pairs.size}`);
    return quote;
  });
  const sources = {
    stations,
    lines,
    timetables,
    lrtEdges: parseLrtEdges(matrix),
    quotes,
    serviceCalendar: calendar.calendar,
    calendarSource: calendar.source
  };
  await mkdir(opts.cacheDir, { recursive: true });
  await writeFile(join(opts.cacheDir, 'sources.json'), JSON.stringify(sources));
  return sources;
}
