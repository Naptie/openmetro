/**
 * Official-source fetch for cn-urumqi.
 *
 * The operator website (urumqimtr.com) is an Aliyun smart-site builder: the
 * whole network — Line 1 (21 stations) and the airport APM (2 stations) — is
 * published only as static images (network map, first/last-train sheet, OD
 * fare matrix). There is no structured endpoint and this adapter deliberately
 * has no OCR path. The machine-readable topology source is therefore the
 * public AMap subway dataset (GCJ-02 native, city code 6501); first/last
 * trains, segment metrics and OD fares are harvested live from the Baidu
 * Direction planner (see `timetables.ts`, `segments.ts`, `fares.ts`).
 */
import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/6501_drw_wulumuqi.json';
export const AMAP_REFERER = 'https://www.urumqimtr.com/';

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

export interface UrumqiSources {
  amapSubway: AmapSubwayDoc;
}

export async function fetchUrumqiSources(): Promise<UrumqiSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 6501_drw_wulumuqi.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY);
  const lineCount = amapSubway.l?.length ?? 0;
  if (lineCount < 2) {
    throw new Error(`AMap subway doc for Ürümqi has ${lineCount} lines, expected >= 2`);
  }
  const stationCount = amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0) ?? 0;
  // 1号线 (21) + 机场捷运 (2); leave headroom for Line 2's opening rather
  // than pinning today's network.
  if (stationCount < 23) {
    throw new Error(`AMap subway doc for Ürümqi has ${stationCount} station rows, expected >= 23`);
  }
  console.log(`    ${lineCount} lines, ${stationCount} station entries`);

  return { amapSubway };
}
