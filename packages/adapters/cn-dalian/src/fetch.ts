/**
 * Official-source fetch for cn-dalian.
 *
 * Dalian has **no machine-readable official source**: the former operator site
 * `www.dlmetro.com` no longer resolves (the operator was restructured into
 * 大连交通集团 in 2022-06 and its site `www.dltransgrp.com` carries only
 * corporate news and bus-service notices). First/last trains reach passengers
 * solely as images through the 大连地铁 APP / WeChat mini-program — the same
 * situation as Qingdao, so no OCR path is attempted here.
 *
 * One structured source is used for topology:
 * - The public AMap subway dataset (`2102_drw_dalian.json`): station names and
 *   order, GCJ-02 coordinates, schematic pixels, romanisations, English names
 *   and line colours. The identical document is also served by
 *   `map.amap.com/service/subway?srhdata=2102_drw_dalian.json`, which is what
 *   the city-agnostic geocoding chain in `core` reads.
 *
 * Timetables and in-vehicle distances come from the Baidu planner at sync time
 * (see `timetables.ts` / `distances.ts`), so `data/` stays live.
 */
import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/2102_drw_dalian.json';
const AMAP_REFERER = 'https://www.dlmetro.com/';

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
    return await curlBuffer(url, referer);
  } catch (curlErr) {
    const res = await fetch(url, {
      headers: { ...officialFetchHeaders(), Referer: referer },
      signal: AbortSignal.timeout(90_000)
    }).catch((fetchErr) => {
      throw new Error(`curl failed (${curlErr}); fetch failed (${fetchErr})`);
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (after curl failure: ${curlErr})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function getJson<T>(url: string, referer: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return JSON.parse((await fetchBuffer(url, referer)).toString('utf-8')) as T;
    } catch (err) {
      lastErr = err;
      const delay = 500 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// AMap subway dataset
// ---------------------------------------------------------------------------

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
  /** `1` marks an interchange stop. */
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
  multilang?: { ln?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

/** The AMap document is the only structured source; nothing else to stage. */
export interface DalianSources {
  amapSubway: AmapSubwayDoc;
}

export async function fetchDalianSources(): Promise<DalianSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 2102_drw_dalian.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  const lines = amapSubway.l ?? [];
  const stationEntries = lines.reduce((n, l) => n + (l.st?.length ?? 0), 0);
  // Six operating lines; AMap splits the 3号线 九里支线 out as a seventh entry.
  if (lines.length !== 7 || stationEntries < 100) {
    throw new Error(
      `AMap subway doc for Dalian has ${lines.length} lines / ${stationEntries} stop entries, expected 7 / >=100`
    );
  }
  console.log(`    ${lines.length} AMap entries, ${stationEntries} station entries`);

  return { amapSubway };
}
