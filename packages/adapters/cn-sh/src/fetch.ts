import { deriveLineEnglishName, officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { type FlTimeRow, fetchAllLines } from './viewlnfltime.js';

const BASE = 'https://m.shmetro.com';

/** Shanghai Metro line numbers, including the two special-municipality lines. */
export const LINE_NOS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '41',
  '51'
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm(path: string, body: Record<string, string>): Promise<string> {
  const res = await fetch(proxyUrl(`${BASE}${path}`), {
    method: 'POST',
    headers: officialFetchHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams(body).toString()
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.text();
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(proxyUrl(`${BASE}${path}`), {
    headers: officialFetchHeaders()
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function getText(url: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: 'https://m.shmetro.com/' }),
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

export function parseSlsddl(html: string): { code: string; name: string }[] {
  const re = /<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g;
  const out: { code: string; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ code: m[1], name: m[2].trim() });
  }
  return out;
}

export interface ShFetchResult {
  lineSequences: Record<string, { code: string; name: string }[]>;
  stations: Record<string, unknown[]>;
}

async function fetchStationCode(code: string, func: string): Promise<unknown[]> {
  const data = (await getJson(
    `/interface/metromap/metromap.aspx?func=${func}&station_code=${encodeURIComponent(code)}`
  )) as unknown;
  // Guard against proxy/origin error payloads (e.g. bare `500`).
  if (!Array.isArray(data)) {
    throw new Error(`stationInfo ${code}: expected array, got ${typeof data}`);
  }
  return data;
}

/** Fetch Shanghai per-line station sequences and station info. */
export async function fetchShanghai(
  lineNos: readonly string[],
  nameToCodes: Record<string, string[]>,
  opts: { delayMs?: number; concurrency?: number } = {}
): Promise<ShFetchResult> {
  const delayMs = opts.delayMs ?? 200;
  const concurrency = opts.concurrency ?? 3;

  // 1) Line sequences.
  const lineSequences: Record<string, { code: string; name: string }[]> = {};
  for (const ln of lineNos) {
    const html = await postForm('/core/shmetro/mdstationinfoback_new.ashx', {
      act: 'slsddl',
      ln: ln,
      sc: ''
    });
    lineSequences[ln] = parseSlsddl(html);
    await sleep(delayMs);
  }

  // 2) Station info for each unique map code (a name may own several).
  const codes = [...new Set(Object.values(nameToCodes).flat())];
  const stations: Record<string, unknown[]> = {};
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= codes.length) return;
      const code = codes[i];
      try {
        stations[code] = await fetchStationCode(code, 'stationInfo');
      } catch {
        // skip failed station; leave absent
      }
      await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { lineSequences, stations };
}

interface Mapplic {
  levels: { locations: { id: string; title: string }[] }[];
}

export interface ShanghaiSources {
  /** Chinese title → every distinct official map code for that title. */
  nameToCodes: Record<string, string[]>;
  lines: Record<string, { line_no: number; description: string; desc_en: string; color: string }>;
  lineSequences: Record<string, { code: string; name: string }[]>;
  stations: Record<string, unknown[]>;
  fltimeRows: Record<string, FlTimeRow[]>;
  lineNotes: Record<string, string | undefined>;
}

/** Fetch Shanghai map bootstrap + topology + first/last tables live. */
export async function fetchShanghaiSources(): Promise<ShanghaiSources> {
  console.log('  fetch lineInfo (map locations)');
  const lineInfo = await getText(`${BASE}/interface/metromap/metromap.aspx?func=lineInfo`);
  const mapplic = JSON.parse(lineInfo.replace(/^\uFEFF/, '')) as Mapplic;
  // Keep every map code: the same public name can sit on several physical
  // stations (e.g. 浦东南路 on Line 2 vs Line 14). Overwriting by title
  // would drop all but the last code and hide the split.
  const nameToCodes: Record<string, string[]> = {};
  for (const loc of mapplic.levels[0].locations) {
    if (!loc.id.startsWith('ST')) continue;
    const code = loc.id.slice(2);
    const list = (nameToCodes[loc.title] ??= []);
    if (!list.includes(code)) list.push(code);
  }

  console.log('  fetch lines (colors)');
  const linesRaw = await getText(`${BASE}/interface/metromap/metromap.aspx?func=lines`);
  const parsed = JSON.parse(linesRaw) as { line_no: number; color: string; bgcolor: string }[];
  const lines: ShanghaiSources['lines'] = {};
  for (const l of parsed) {
    lines[String(l.line_no)] = {
      line_no: l.line_no,
      color: l.color,
      description: `${l.line_no}号线`,
      desc_en: `Line ${l.line_no}`
    };
  }

  console.log('  fetch line sequences + station info');
  const { lineSequences, stations } = await fetchShanghai(LINE_NOS, nameToCodes, {
    delayMs: 150,
    concurrency: 3
  });

  console.log('  fetch first/last timetables');
  const fltime = await fetchAllLines([...LINE_NOS], { delayMs: 120 });
  const fltimeRows: Record<string, FlTimeRow[]> = {};
  const lineNotes: Record<string, string | undefined> = {};
  for (const [ln, value] of fltime) {
    fltimeRows[ln] = value.rows;
    lineNotes[ln] = value.note;
    // Official names (e.g. 浦江线 / 市域机场线) come from the timetable page,
    // not from the color-only `func=lines` endpoint.
    if (value.name && lines[ln]) {
      lines[ln].description = value.name;
      lines[ln].desc_en = deriveLineEnglishName(value.name, ln) ?? `Line ${ln}`;
    }
  }

  return { nameToCodes, lines, lineSequences, stations, fltimeRows, lineNotes };
}
