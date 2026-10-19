import { inflateRawSync } from 'node:zlib';
import { officialFetchHeaders, proxyUrl } from '../geocode/proxy.js';
import { canonicalizePatterns } from '../graph/patterns.js';
import type {
  GeoPoint,
  LineEncoded,
  PatternEncoded,
  SegmentEncoded,
  StationEncoded,
  StopEncoded
} from '../schema/index.js';

/** CSV state machine: quoted fields can contain commas, quotes and line breaks. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell);
      cell = '';
      if (c !== ',') {
        if (row.some((v) => v !== '')) rows.push(row);
        row = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift();
  if (!headers?.length) throw new Error('Empty CSV feed');
  return rows.map((values) => {
    if (values.length !== headers.length)
      throw new Error(`CSV columns: expected ${headers.length}, got ${values.length}`);
    return Object.fromEntries(headers.map((key, i) => [key, values[i]!]));
  });
}

export function decodeFeed(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('big5', { fatal: true }).decode(bytes);
  }
}

export async function fetchFeed(
  url: string,
  init?: RequestInit,
  validate?: (bytes: Uint8Array) => unknown
): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        ...init,
        headers: officialFetchHeaders({
          'User-Agent': 'openmetro/0.1 (https://github.com/Naptie/openmetro)',
          ...Object.fromEntries(new Headers(init?.headers))
        }),
        signal: init?.signal ?? AbortSignal.timeout(60_000)
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`${init?.method ?? 'GET'} ${url}: ${res.status}`), {
          status: res.status,
          permanent: res.status < 500 && res.status !== 408 && res.status !== 429,
          retryAfter: res.headers.get('Retry-After')
        });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      validate?.(bytes);
      return bytes;
    } catch (error) {
      if (attempt >= 2 || init?.signal?.aborted || (error as { permanent?: boolean }).permanent)
        throw error;
      const header = (error as { retryAfter?: string | null }).retryAfter;
      const retryAfter =
        header == null
          ? NaN
          : /^\d+$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now();
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Number.isFinite(retryAfter)
            ? Math.max(0, Math.min(retryAfter, 30_000))
            : 1000 * 2 ** attempt
        )
      );
    }
  }
}

export async function fetchFeedText(url: string, init?: RequestInit): Promise<string> {
  return decodeFeed(await fetchFeed(url, init));
}

export function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a named ZIP member via its central directory (ODT/XLSX, stored or deflated). */
export function zipMember(bytes: Uint8Array, name: string): string {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= Math.max(0, b.length - 65557) && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0 || b.readUInt32LE(eocd) !== 0x06054b50) throw new Error('Invalid ZIP directory');
  let p = b.readUInt32LE(eocd + 16);
  while (p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50) {
    const method = b.readUInt16LE(p + 10),
      size = b.readUInt32LE(p + 20);
    const n = b.readUInt16LE(p + 28),
      extra = b.readUInt16LE(p + 30),
      comment = b.readUInt16LE(p + 32);
    if (b.toString('utf8', p + 46, p + 46 + n) === name) {
      const local = b.readUInt32LE(p + 42);
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP method ${method}`);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + n + extra + comment;
  }
  throw new Error(`Missing ZIP member ${name}`);
}

export interface FeedStation {
  code: string;
  /** Real operator code when an internal key distinguishes services at one station. */
  source_code?: string;
  /** Explicit physical identity; separate source codes can share a station. */
  key: string;
  zh: string;
  en: string;
  location?: GeoPoint;
  source?: string;
  enrichment_id?: string;
  extras?: Record<string, unknown>;
}
export interface FeedLine {
  code: string;
  zh: string;
  en: string;
  color: string;
  mode: LineEncoded['mode'];
}
export interface FeedAlignment {
  id: string;
  line: string;
  codes: string[];
}

/** City-agnostic adapter assembly. Topology follows alignments, never numeric code order. */
export function buildFeedTopology(input: {
  networkId: string;
  source: string;
  lines: FeedLine[];
  stations: FeedStation[];
  alignments: FeedAlignment[];
}) {
  const { networkId: net, source } = input;
  const lines: LineEncoded[] = input.lines.map((l) => ({
    id: `${net}-line-${l.code.toLowerCase()}`,
    name: l.zh,
    names: { zh: l.zh, en: l.en },
    aliases: [],
    short_name: l.code,
    color: l.color,
    mode: l.mode,
    status: 'operating',
    loop: false,
    source_ids: [{ source, id: l.code }]
  }));
  const raw = new Map(input.stations.map((s) => [s.code, s]));
  const physical = new Map<
    string,
    Omit<StationEncoded, 'source_ids'> & { source_ids: { source: string; id: string }[] }
  >();
  const stops = new Map<string, StopEncoded>();
  const stopByCode = new Map<string, StopEncoded>();
  const stationByCode = new Map<string, StationEncoded>();
  const candidates: PatternEncoded[] = [];
  for (const a of input.alignments) {
    const line = lines.find((l) => l.short_name === a.line);
    if (!line) throw new Error(`Unknown line ${a.line}`);
    const ids = a.codes.map((code) => {
      const s = raw.get(code);
      if (!s) throw new Error(`Missing source station ${code}`);
      let station = physical.get(s.key);
      if (!station) {
        station = {
          id: `${net}-station-${s.key}`,
          name: s.zh,
          names: { zh: s.zh, en: s.en },
          location: s.location,
          status: 'operating',
          source_ids: [],
          extras: { location_source: s.enrichment_id ? 'overpass' : 'official', ...s.extras }
        };
        physical.set(s.key, station);
      }
      const sourceCode = s.source_code ?? code;
      if (!station.source_ids.some((r) => r.id === sourceCode))
        station.source_ids.push({ source: s.source ?? source, id: sourceCode });
      if (s.enrichment_id && !station.source_ids.some((r) => r.id === s.enrichment_id))
        station.source_ids.push({ source: 'openstreetmap', id: s.enrichment_id });
      stationByCode.set(code, station);
      const id = `${net}-stop-${code.toLowerCase()}`;
      if (!stops.has(id))
        stops.set(id, {
          id,
          station_id: station.id,
          line_id: line.id,
          sequence: [...stops.values()].filter((s) => s.line_id === line.id).length,
          source_id: sourceCode
        });
      const stop = stops.get(id)!;
      if (stop.line_id !== line.id)
        throw new Error(`Station code ${code} belongs to multiple lines`);
      stopByCode.set(code, stop);
      return id;
    });
    if (ids.length < 2 || new Set(ids).size !== ids.length)
      throw new Error(`Invalid alignment ${a.id}`);
    candidates.push({
      id: `${net}-pattern-${a.id.toLowerCase()}`,
      line_id: line.id,
      stop_ids: ids,
      origin_stop_id: ids[0]!,
      terminal_stop_id: ids.at(-1)!,
      is_primary: false,
      source_ids: [{ source, id: a.id }]
    });
  }
  const patterns = canonicalizePatterns(candidates).patterns;
  const segments = new Map<string, SegmentEncoded>();
  for (const p of patterns) {
    for (let i = 1; i < p.stop_ids.length; i++) {
      const from = stops.get(p.stop_ids[i - 1]!)!,
        to = stops.get(p.stop_ids[i]!)!;
      const key = [from.id, to.id].sort().join('|');
      if (segments.has(key)) continue;
      segments.set(key, {
        id: `${p.line_id}-segment-${segments.size + 1}`,
        line_id: p.line_id,
        from_stop_id: from.id,
        to_stop_id: to.id,
        from_station_id: from.station_id,
        to_station_id: to.station_id,
        direction: 'both',
        source_id: source
      });
    }
  }
  return {
    lines,
    stations: [...physical.values()],
    stops: [...stops.values()],
    patterns,
    segments: [...segments.values()],
    stopByCode,
    stationByCode
  };
}
