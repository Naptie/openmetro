import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const BASE = 'https://www.njmetro.com.cn';
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3201_drw_nanjing.json';
const AMAP_REFERER = 'https://www.njmetro.com.cn/';

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

function curlText(url: string): Promise<string> {
  return curlBuffer(url).then((b) => b.toString('utf-8'));
}

async function fetchBuffer(targetUrl: string): Promise<Buffer> {
  const url = proxyUrl(targetUrl);
  try {
    return await curlBuffer(url);
  } catch (curlErr) {
    const res = await fetch(url, {
      headers: officialFetchHeaders(),
      signal: AbortSignal.timeout(90_000)
    }).catch((fetchErr) => {
      throw new Error(`curl failed (${curlErr}); fetch failed (${fetchErr})`);
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (after curl failure: ${curlErr})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function fetchText(targetUrl: string): Promise<string> {
  return (await fetchBuffer(targetUrl)).toString('utf-8');
}

async function getText(url: string, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetchText(url);
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
  const text = await getText(url, retries);
  return JSON.parse(text) as T;
}

async function getBytes(url: string, retries = 3): Promise<Uint8Array> {
  const buf = await (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fetchBuffer(url);
      } catch (err) {
        lastErr = err;
        const delay = 500 * 2 ** attempt;
        console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
        await sleep(delay);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })();
  return new Uint8Array(buf);
}

/** Official line id used by get-stationList / timetable image names. */
export interface NjLineOption {
  /** `L1`, `LS1`, … */
  reLineId: string;
  /** Display name `1号线`, `S1号线`. */
  lineName: string;
  /** Short badge `1`, `S1`. */
  shortName: string;
}

export interface NjOfficialStation {
  rowId: string;
  stationName: string;
  stationLine: string;
  stationOrder: number;
  reLineId: string;
  stationType?: string | null;
  stationStatus?: string | null;
}

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  sl?: string;
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  cl?: string;
  la?: string;
  el?: string;
  ls?: string;
  li?: string;
  c?: string | string[];
  f?: unknown;
  lo?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string>; kn?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface NanjingSources {
  stationsByLine: Record<string, NjOfficialStation[]>;
  lines: NjLineOption[];
  amapSubway: AmapSubwayDoc;
}

export const NJ_LINES: NjLineOption[] = [
  { reLineId: 'L1', lineName: '1号线', shortName: '1' },
  { reLineId: 'L2', lineName: '2号线', shortName: '2' },
  { reLineId: 'L3', lineName: '3号线', shortName: '3' },
  { reLineId: 'L4', lineName: '4号线', shortName: '4' },
  { reLineId: 'L5', lineName: '5号线', shortName: '5' },
  { reLineId: 'L7', lineName: '7号线', shortName: '7' },
  { reLineId: 'L10', lineName: '10号线', shortName: '10' },
  { reLineId: 'LS1', lineName: 'S1号线', shortName: 'S1' },
  { reLineId: 'LS2', lineName: 'S2号线', shortName: 'S2' },
  { reLineId: 'LS3', lineName: 'S3号线', shortName: 'S3' },
  { reLineId: 'LS6', lineName: 'S6号线', shortName: 'S6' },
  { reLineId: 'LS7', lineName: 'S7号线', shortName: 'S7' },
  { reLineId: 'LS8', lineName: 'S8号线', shortName: 'S8' },
  { reLineId: 'LS9', lineName: 'S9号线', shortName: 'S9' }
];

export async function fetchNanjingSources(): Promise<NanjingSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch official station lists');
  const stationsByLine: Record<string, NjOfficialStation[]> = {};
  for (const line of NJ_LINES) {
    const url = `${BASE}/njdtweb/portal/get-stationList.do?reLineId=${encodeURIComponent(line.reLineId)}`;
    const doc = await getJson<{ stationList?: NjOfficialStation[] }>(url);
    const list = doc.stationList ?? [];
    if (list.length < 2) {
      throw new Error(`njmetro stationList empty for ${line.reLineId}`);
    }
    stationsByLine[line.reLineId] = list;
    console.log(`    ${line.shortName}: ${list.length} stations`);
  }

  console.log('  fetch AMap subway 3201_drw_nanjing.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY);

  return { stationsByLine, lines: NJ_LINES, amapSubway };
}

/** Official OD fare names are double-URL-encoded (site JS). */
export function encodeFareName(name: string): string {
  return encodeURIComponent(encodeURIComponent(name));
}

export async function fetchNanjingFare(startName: string, endName: string): Promise<number | null> {
  const url = `${BASE}/njdtweb/mobileTicketAction/getPrice.do?starts=${encodeFareName(startName)}&ends=${encodeFareName(endName)}`;
  const text = await getText(url);
  try {
    const j = JSON.parse(text) as { price?: number | string | null };
    const price = Number(j.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
