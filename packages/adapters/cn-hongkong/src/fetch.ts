import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const MTR_OPEN_DATA = 'https://opendata.mtr.com.hk/data';
export const LINES_AND_STATIONS_CSV = `${MTR_OPEN_DATA}/mtr_lines_and_stations.csv`;
export const LINES_FARES_CSV = `${MTR_OPEN_DATA}/mtr_lines_fares.csv`;
export const AIRPORT_EXPRESS_FARES_CSV = `${MTR_OPEN_DATA}/airport_express_fares.csv`;
/** AMap subway map (GCJ-02). Matched by English name — MTR publishes traditional Chinese. */
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/8100_drw_xianggang.json';
export const SERVICE_HOURS_URL =
  'https://www.mtr.com.hk/ch/customer/services/service_hours_search.php';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders(),
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

export interface MtrLineStationRow {
  lineCode: string;
  direction: string;
  stationCode: string;
  stationId: string;
  chineseName: string;
  englishName: string;
  sequence: number;
}

export interface MtrFareRow {
  srcName: string;
  srcId: string;
  destName: string;
  destId: string;
  octAdtFare: number;
  singleAdtFare: number | null;
}

export interface AirportExpressFareRow {
  srcName: string;
  srcId: string;
  destName: string;
  destId: string;
  octAdtFare: number;
  singleAdtFare: number | null;
}

export interface AmapHkStation {
  en: string;
  zh: string;
  lon: number;
  lat: number;
}

export interface MtrSources {
  lineStations: MtrLineStationRow[];
  fares: MtrFareRow[];
  airportExpressFares: AirportExpressFareRow[];
  amapStations: AmapHkStation[];
  /** MTR numeric station id -> service-hours rows. */
  serviceHours: Map<string, ServiceHoursRow[]>;
}

/** Minimal RFC4180 CSV reader (quotes + escaped quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function headerIndex(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    m.set(h.trim(), i);
  });
  return m;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx == null) return '';
  return (row[idx] ?? '').trim();
}

function num(raw: string): number | null {
  if (!raw) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export function parseLineStations(text: string): MtrLineStationRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const h = headerIndex(rows[0]);
  const out: MtrLineStationRow[] = [];
  for (const r of rows.slice(1)) {
    const lineCode = cell(r, h.get('Line Code'));
    const stationId = cell(r, h.get('Station ID'));
    const englishName = cell(r, h.get('English Name'));
    if (!lineCode || !stationId || !englishName) continue;
    const sequence = num(cell(r, h.get('Sequence')));
    if (sequence == null) continue;
    out.push({
      lineCode,
      direction: cell(r, h.get('Direction')),
      stationCode: cell(r, h.get('Station Code')),
      stationId,
      chineseName: cell(r, h.get('Chinese Name')),
      englishName,
      sequence
    });
  }
  return out;
}

export function parseLinesFares(text: string): MtrFareRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const h = headerIndex(rows[0]);
  const out: MtrFareRow[] = [];
  for (const r of rows.slice(1)) {
    const srcName = cell(r, h.get('SRC_STATION_NAME'));
    const destName = cell(r, h.get('DEST_STATION_NAME'));
    const oct = num(cell(r, h.get('OCT_ADT_FARE')));
    if (!srcName || !destName || oct == null) continue;
    out.push({
      srcName,
      srcId: cell(r, h.get('SRC_STATION_ID')),
      destName,
      destId: cell(r, h.get('DEST_STATION_ID')),
      octAdtFare: oct,
      singleAdtFare: num(cell(r, h.get('SINGLE_ADT_FARE')))
    });
  }
  return out;
}

export function parseAirportExpressFares(text: string): AirportExpressFareRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const h = headerIndex(rows[0]);
  const out: AirportExpressFareRow[] = [];
  for (const r of rows.slice(1)) {
    const srcName = cell(r, h.get('ST_FROM'));
    const destName = cell(r, h.get('ST_TO'));
    const oct = num(cell(r, h.get('OCT_ADT_FARE')));
    if (!srcName || !destName || oct == null) continue;
    out.push({
      srcName,
      srcId: cell(r, h.get('ST_FROM_ID')),
      destName,
      destId: cell(r, h.get('ST_TO_ID')),
      octAdtFare: oct,
      singleAdtFare: num(cell(r, h.get('SINGLE_ADT_FARE')))
    });
  }
  return out;
}

export function parseAmapHkStations(text: string): AmapHkStation[] {
  const doc = JSON.parse(text) as {
    l?: {
      st?: {
        n?: string;
        sl?: string;
        multilang?: { n?: { en?: string; 'zh-Hant-HK'?: string } };
      }[];
    }[];
  };
  const out: AmapHkStation[] = [];
  for (const line of doc.l ?? []) {
    for (const s of line.st ?? []) {
      const sl = s.sl;
      if (!sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const zh = s.multilang?.n?.['zh-Hant-HK'] || s.n || '';
      const en = s.multilang?.n?.en || zh;
      if (!en) continue;
      out.push({ en, zh, lon, lat });
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.en.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function fetchMtrSources(): Promise<MtrSources> {
  console.log('  fetch mtr_lines_and_stations.csv');
  const lineStationsText = await getText(LINES_AND_STATIONS_CSV);
  console.log('  fetch mtr_lines_fares.csv');
  const faresText = await getText(LINES_FARES_CSV);
  console.log('  fetch airport_express_fares.csv');
  const aelText = await getText(AIRPORT_EXPRESS_FARES_CSV);
  console.log('  fetch AMap Hong Kong subway');
  const amapText = await getText(AMAP_SUBWAY);
  const lineStations = parseLineStations(lineStationsText);
  const stationIds = [...new Set(lineStations.map((r) => r.stationId))].sort(
    (a, b) => Number(a) - Number(b)
  );
  console.log(`  fetch service hours (${stationIds.length} stations)`);
  const serviceHours = await fetchAllServiceHours(stationIds);
  return {
    lineStations,
    fares: parseLinesFares(faresText),
    airportExpressFares: parseAirportExpressFares(aelText),
    amapStations: parseAmapHkStations(amapText),
    serviceHours
  };
}

export interface ServiceHoursRow {
  lineCode: string;
  /** MTR numeric station id; `_ael` platform suffix stripped. */
  destStationId: string;
  /** `HHMM` from the page. */
  first: string;
  last: string;
}

/** Parse one service_hours_search.php HTML into per-line first/last rows. */
export function parseServiceHours(html: string): ServiceHoursRow[] {
  const out: ServiceHoursRow[] = [];
  let lineCode = '';
  const re =
    /<h2 class="trainLine ([A-Z]+)"|<td class="tr-color"><span class="js_station_([0-9a-zA-Z_]+)"[^>]*>[^<]*<\/span><\/td>\s*<td class="firstTrain">([0-9]{4})<\/td>\s*<td[^>]*>([0-9]{4})<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      lineCode = m[1];
      continue;
    }
    const destRaw = m[2] ?? '';
    const destStationId = destRaw.replace(/_ael$/i, '');
    if (!lineCode || !destStationId) continue;
    out.push({ lineCode, destStationId, first: m[3]!, last: m[4]! });
  }
  return out;
}

export async function fetchServiceHours(
  stationId: string,
  retries = 3
): Promise<ServiceHoursRow[]> {
  const url = `${SERVICE_HOURS_URL}?query_type=search&station=${encodeURIComponent(stationId)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({
          Referer: 'https://www.mtr.com.hk/ch/customer/services/service_hours.html'
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return parseServiceHours(await res.text());
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchAllServiceHours(
  stationIds: string[],
  opts: { concurrency?: number; delayMs?: number } = {}
): Promise<Map<string, ServiceHoursRow[]>> {
  const concurrency = opts.concurrency ?? 8;
  const delayMs = opts.delayMs ?? 40;
  const result = new Map<string, ServiceHoursRow[]>();
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= stationIds.length) return;
      const id = stationIds[i]!;
      try {
        result.set(id, await fetchServiceHours(id));
      } catch (err) {
        console.log(`  service hours ${id} failed: ${err}`);
        result.set(id, []);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, stationIds.length) }, () => worker())
  );
  return result;
}
