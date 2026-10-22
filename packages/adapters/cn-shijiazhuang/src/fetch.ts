/**
 * Official-source fetch for cn-shijiazhuang.
 *
 * The operator website (www.sjzmetro.cn, 石家庄市轨道交通集团) publishes the
 * whole operating network through a small set of unauthenticated JSON
 * endpoints under `/metro/`:
 *
 * - `GET  /metro/lines.html`             → the operating lines
 * - `GET  /metro/stations.html?lineId=N` → that line's stops, in line order
 * - `POST /metro/recommend.html`         → route planner (fare / time / path)
 * - `POST /metro/maps.html`              → station exit markers
 *
 * Two operational facts drive this module:
 *
 * 1. **The site is HTTP-only.** Its HTTPS endpoint fails the TLS handshake
 *    from every client we tried (direct egress and the local proxy alike), so
 *    `SITE` must stay `http://`. `proxyUrl` still applies so a CN reverse
 *    proxy can front it.
 * 2. **The site rate-limits hard.** A burst of requests makes the origin
 *    accept the connection and then never answer (60 s timeouts) until the
 *    burst window expires. The topology endpoints need only four requests,
 *    so they are spaced out; the route planner is never used for bulk work.
 *
 * Coordinates, pinyin and the schematic pixel grid come from the public AMap
 * subway dataset (city code 1301), whose station names match the official
 * feed one-to-one.
 */
import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

/** HTTP-only on purpose — the operator's HTTPS endpoint fails the handshake. */
export const SJZ_SITE = 'http://www.sjzmetro.cn';
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/1301_drw_shijiazhuang.json';
export const AMAP_REFERER = `${SJZ_SITE}/`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlBuffer(url: string, referer: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-sS',
      '-L',
      '--max-time',
      '120',
      '-A',
      officialFetchHeaders()['User-Agent'] as string,
      '-H',
      'Accept: */*',
      '-H',
      'Accept-Encoding: identity',
      '-H',
      `Referer: ${referer}`,
      url
    ];
    const child = spawn('curl', args, { windowsHide: true });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks));
      else
        reject(
          new Error(`curl exited ${code}: ${Buffer.concat(errChunks).toString('utf-8').trim()}`)
        );
    });
  });
}

async function fetchBuffer(targetUrl: string, referer: string): Promise<Buffer> {
  const url = proxyUrl(targetUrl);
  try {
    const res = await fetch(url, {
      headers: { ...officialFetchHeaders(), Referer: referer },
      signal: AbortSignal.timeout(90_000)
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (fetchErr) {
    // The operator's origin is flaky behind some networks; curl with an
    // explicit identity encoding is the reliable path.
    try {
      return await curlBuffer(url, referer);
    } catch (curlErr) {
      throw new Error(`fetch failed (${fetchErr}); curl failed (${curlErr})`);
    }
  }
}

async function getText(url: string, referer: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return (await fetchBuffer(url, referer)).toString('utf-8');
    } catch (err) {
      lastErr = err;
      const delay = 1500 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer: string, retries = 4): Promise<T> {
  return JSON.parse(await getText(url, referer, retries)) as T;
}

/** Envelope shared by every `/metro/` JSON endpoint. */
export interface SjzEnvelope<T> {
  /** `1` on success. */
  status?: number | boolean;
  msg?: string;
  data?: T;
}

/** `/metro/lines.html` entry. */
export interface SjzLine {
  line_id: number;
  line_name: string;
  /** Operator line colour, hex without `#` (e.g. `cf6e6b`). */
  color_code?: string;
  start_station_id?: number;
  end_station_id?: number;
  is_circle_line?: number;
  description?: string | null;
}

/**
 * `/metro/stations.html?lineId=N` entry.
 *
 * `station_id` is a **global physical-station id**: the three interchanges
 * share one id across the lines they serve (6 = 新百广场, 9 = 北国商城,
 * 65 = 石家庄站).
 *
 * Two feed quirks this adapter works around:
 * - `line_id` / `order_on_line` describe the station's **primary** line, so
 *   for a station that also appears in another line's list they carry the
 *   other line's numbering. The station's position **in this list** is the
 *   authoritative order — `order_on_line` must not be used.
 * - `transfer` / `transfer_id` name the **other** line the station connects
 *   to, which is how interchanges are detected.
 */
export interface SjzStation {
  station_id: number;
  station_name: string;
  line_id: number;
  latitude: number | null;
  longitude: number | null;
  transfer_info?: string;
  order_on_line?: number;
  img?: string;
  img_alt?: string;
  img_title?: string;
  map_content?: string | null;
  img_group?: string | null;
  last_modified?: number;
  /** Other line served, e.g. `3号线`. */
  transfer?: string;
  /** Other line id, e.g. `3`. */
  transfer_id?: string;
}

export interface AmapStation {
  n?: string;
  en?: string;
  /** CamelCase pinyin (`XiWang`) — the only English source for this network. */
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  /** `1` when the line is a loop. */
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

export interface ShijiazhuangSources {
  /** Official line registry. */
  lines: SjzLine[];
  /** Official stops per line id, in line order. */
  stationsByLine: Map<number, SjzStation[]>;
  amap: AmapSubwayDoc;
}

/** Official operating lines. */
export async function fetchSjzLines(): Promise<SjzLine[]> {
  const env = await getJson<SjzEnvelope<SjzLine[]>>(
    `${SJZ_SITE}/metro/lines.html`,
    `${SJZ_SITE}/service/trip.html`
  );
  const data = env.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`sjzmetro /metro/lines.html failed: ${env.msg || 'empty'}`);
  }
  return data;
}

/** Official stops of one line, in line order. */
export async function fetchSjzStations(lineId: number): Promise<SjzStation[]> {
  const env = await getJson<SjzEnvelope<SjzStation[]>>(
    `${SJZ_SITE}/metro/stations.html?lineId=${lineId}`,
    `${SJZ_SITE}/service/trip.html`
  );
  const data = env.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`sjzmetro /metro/stations.html?lineId=${lineId} failed: ${env.msg || 'empty'}`);
  }
  return data;
}

/** AMap subway dataset (GCJ-02 native). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  return getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
}

export async function fetchShijiazhuangSources(): Promise<ShijiazhuangSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch /metro/lines.html');
  const lines = await fetchSjzLines();
  console.log(`    ${lines.length} lines: ${lines.map((l) => l.line_name).join(', ')}`);

  const stationsByLine = new Map<number, SjzStation[]>();
  for (const line of lines) {
    // Spaced out: the origin throttles bursts.
    await sleep(1200);
    console.log(`  fetch /metro/stations.html?lineId=${line.line_id}`);
    const stations = await fetchSjzStations(line.line_id);
    stationsByLine.set(line.line_id, stations);
    console.log(`    ${line.line_name}: ${stations.length} stops`);
  }

  console.log('  fetch AMap subway 1301_drw_shijiazhuang.json');
  const amap = await fetchAmapSubway();

  const officialStopCount = [...stationsByLine.values()].reduce((n, s) => n + s.length, 0);
  if (lines.length < 3 || officialStopCount < 60) {
    throw new Error(
      `sjzmetro feed looks truncated: ${lines.length} lines, ${officialStopCount} stops (expected >= 3 lines / >= 60 stops)`
    );
  }
  const amapStopCount = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    official ${officialStopCount} stop rows, AMap ${amapStopCount} stop rows`);

  return { lines, stationsByLine, amap };
}
