import { spawn } from 'node:child_process';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const BASE = 'https://map.bjsubway.com/subwaymap';
const TIMEINFOS = 'https://www.bjsubway.com/api/guanwang/v2/getTimeinfos';
const STATIONS_API = 'https://map.bjsubway.com/stations';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlText(url: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-sS',
      '-L',
      '--max-time',
      '90',
      '-A',
      officialFetchHeaders()['User-Agent'] as string,
      '-H',
      'Accept: */*',
      // Proxy responses may claim a content-encoding curl cannot decode; prefer raw body.
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
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf-8'));
      else
        reject(
          new Error(`curl exited ${code}: ${Buffer.concat(errChunks).toString('utf-8').trim()}`)
        );
    });
  });
}

async function fetchText(targetUrl: string): Promise<string> {
  const url = proxyUrl(targetUrl);
  try {
    return await curlText(url);
  } catch (curlErr) {
    const res = await fetch(url, {
      headers: officialFetchHeaders({ Referer: 'https://map.bjsubway.com/' }),
      signal: AbortSignal.timeout(90_000)
    }).catch((fetchErr) => {
      throw new Error(`curl failed (${curlErr}); fetch failed (${fetchErr})`);
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (after curl failure: ${curlErr})`);
    return await res.text();
  }
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

/** Official Beijing sources, fetched live for each sync. */
export interface BeijingSources {
  beijingXml: string;
  stationsXml: string;
  interchangeXml: string;
  apiStations: unknown[];
  timeinfos: unknown;
}

/**
 * Fetch the official Beijing map sources.
 */
export async function fetchBeijingSources(): Promise<BeijingSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  const texts: Record<string, string> = {};
  const jobs: [string, string][] = [
    ['beijing.xml', `${BASE}/beijing.xml`],
    ['stations.xml', `${BASE}/stations.xml`],
    ['interchange.xml', `${BASE}/interchange.xml`],
    ['timeinfos.json', TIMEINFOS],
    ['api_stations.json', STATIONS_API]
  ];
  for (const [file, url] of jobs) {
    console.log(`  fetch ${file}`);
    texts[file] = await getText(url);
  }
  return {
    beijingXml: texts['beijing.xml'],
    stationsXml: texts['stations.xml'],
    interchangeXml: texts['interchange.xml'],
    apiStations: JSON.parse(texts['api_stations.json']) as unknown[],
    timeinfos: JSON.parse(texts['timeinfos.json'])
  };
}
