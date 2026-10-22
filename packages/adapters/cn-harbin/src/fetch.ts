/**
 * Official-source fetch for cn-harbin.
 *
 * The operator website `www.harbin-metro.com` currently serves a
 * "维护升级中，请稍后访问" placeholder (30 bytes) on every path — straight and
 * through the reverse proxy alike — so it yields no data at all. The Wayback
 * copy of the 2021 CMS shows it only ever published prose + JPEG images
 * (票价及优惠政策 / 车站指南 / 运营时刻), never a structured endpoint.
 *
 * The machine-readable topology source is therefore the public AMap subway
 * dataset (GCJ-02 native, city code 2301). Note the file name: the city is
 * `haerbin` (pinyin), `2301_drw_harbin.json` returns a parse failure.
 */
import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/2301_drw_haerbin.json';
export const AMAP_REFERER = 'https://map.amap.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlBuffer(url: string): Promise<Buffer> {
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
      `Referer: ${AMAP_REFERER}`,
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

async function fetchBuffer(targetUrl: string): Promise<Buffer> {
  const url = proxyUrl(targetUrl);
  try {
    return await curlBuffer(url);
  } catch (curlErr) {
    const res = await fetch(url, {
      headers: { ...officialFetchHeaders(), Referer: AMAP_REFERER },
      signal: AbortSignal.timeout(90_000)
    }).catch((fetchErr) => {
      throw new Error(`curl failed (${curlErr}); fetch failed (${fetchErr})`);
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (after curl failure: ${curlErr})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function getText(url: string, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return (await fetchBuffer(url)).toString('utf-8');
    } catch (err) {
      lastErr = err;
      const delay = 500 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, retries = 3): Promise<T> {
  return JSON.parse(await getText(url, retries)) as T;
}

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  /** Physical-station id — shared across lines for interchanges. */
  si?: string;
  sid?: string;
  /** `1` for an interchange stop. */
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

export interface HarbinSources {
  amapSubway: AmapSubwayDoc;
}

export async function fetchHarbinSources(): Promise<HarbinSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 2301_drw_haerbin.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY);
  const lineCount = amapSubway.l?.length ?? 0;
  if (lineCount < 3) {
    throw new Error(`AMap subway doc for Harbin has ${lineCount} lines, expected >= 3`);
  }
  const stationCount = amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0) ?? 0;
  // 1号线 24 (incl. one duplicate row) + 2号线 19 + 3号线 36 = 79 rows.
  if (stationCount < 78) {
    throw new Error(`AMap subway doc for Harbin has ${stationCount} station rows, expected >= 78`);
  }
  console.log(`    ${lineCount} lines, ${stationCount} station entries`);

  return { amapSubway };
}
