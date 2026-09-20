import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const MAP_BASE = 'https://www.sz-mtr.com/service/guide/map';
const ADMIN_BASE = 'https://www.sz-mtr.com/admin';
const MAP_REFERER = 'https://www.sz-mtr.com/service/guide/map/index_zh.html';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer = MAP_REFERER, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
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

export interface SuzhouSources {
  /** `szmtr.js` — line colors + schematic station sequences. */
  szmtrJs: string;
  /** Chinese station names / pinyin keyed by map node id. */
  stationInfoZhJs: string;
  /** English station names keyed by map node id. */
  stationInfoEnJs: string;
  /** First/last train table keyed by map node id. */
  szmtrTimeJs: string;
  /** Virtual through-service line registry (3 + 11). */
  virtualLines: unknown;
}

/** Official map JS + virtual-line registry, fetched live. */
export async function fetchSuzhouSources(): Promise<SuzhouSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }
  const jobs: [string, string][] = [
    ['szmtr.js', `${MAP_BASE}/javascript/szmtr.js`],
    ['stationInfo_zh.js', `${MAP_BASE}/javascript/stationInfo_zh.js`],
    ['stationInfo_en.js', `${MAP_BASE}/javascript/stationInfo_en.js`],
    ['szmtrTime.js', `${MAP_BASE}/javascript/szmtrTime.js`],
    ['virtualLines', `${ADMIN_BASE}/time_table/getAllVirtualLines.do`]
  ];
  const texts: Record<string, string> = {};
  for (const [key, url] of jobs) {
    console.log(`  fetch ${key}`);
    texts[key] = await getText(url);
  }
  return {
    szmtrJs: texts['szmtr.js'] ?? '',
    stationInfoZhJs: texts['stationInfo_zh.js'] ?? '',
    stationInfoEnJs: texts['stationInfo_en.js'] ?? '',
    szmtrTimeJs: texts['szmtrTime.js'] ?? '',
    virtualLines: JSON.parse(texts['virtualLines'] ?? '{"data":[]}') as unknown
  };
}

export interface SuzhouTransTicket {
  id: string;
  price?: number;
  time?: number;
}

/**
 * One-origin → all-destinations official fare/time list.
 * `sid` is the operator's 4-digit station code (e.g. `0450`).
 */
export async function fetchTransTickets(sid: string): Promise<SuzhouTransTicket[]> {
  const url = proxyUrl(`${ADMIN_BASE}/getTransTickets.do?sid=${encodeURIComponent(sid)}`);
  const res = await fetch(url, {
    headers: officialFetchHeaders({ Referer: MAP_REFERER }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`getTransTickets ${sid} -> ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body as SuzhouTransTicket[];
}

/** Station detail from the official admin API (enrichment extras). */
export async function fetchStationDetail(id: string): Promise<Record<string, unknown> | null> {
  const url = proxyUrl(`${ADMIN_BASE}/stationInfo/getStationInfoById.do?id=${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    headers: officialFetchHeaders({ Referer: MAP_REFERER }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Record<string, unknown>; code?: number };
  return body?.data ?? null;
}
