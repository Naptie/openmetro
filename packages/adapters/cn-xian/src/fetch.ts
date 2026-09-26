import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const SITE = 'https://www.xianrail.com';
const PAS = `${SITE}/pas-gateway-api`;
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/6101_drw_xian.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer = `${SITE}/`, retries = 4): Promise<string> {
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

async function postJson<T>(path: string, body: unknown, retries = 4): Promise<T> {
  const url = proxyUrl(`${PAS}${path}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: officialFetchHeaders({
          'Content-Type': 'application/json',
          Referer: `${SITE}/`
        }),
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer = `${SITE}/`, retries = 4): Promise<T> {
  return JSON.parse(await getText(url, referer, retries)) as T;
}

export interface XianOfficialStation {
  stationId: string;
  stationName: string;
  lineId: string;
  downSequence: number;
  outputName?: string;
  stationEnglishName?: string | null;
  lineNum?: string;
  stationCharacter?: string | null;
  stationOperationState?: string | null;
}

export interface XianOfficialLine {
  lineId: string;
  lineName: string;
  lineShortName?: string;
  lineEnglishName?: string;
  lineType?: string;
  lineLength?: number;
  lineColor?: string | null;
  lineOperationState?: string;
  stations: XianOfficialStation[];
}

export interface XianStationTrainTime {
  timeList: { start?: string; end?: string; direction?: string }[];
  lineName?: string;
}

export interface XianStationInfo {
  bus?: unknown[];
  trainTime?: XianStationTrainTime[];
  buildings?: unknown[];
  facility?: unknown[];
}

export interface XianFareRow {
  startLineId?: string;
  startLineName?: string;
  startStationId: string;
  startStationName?: string;
  endLineId?: string;
  endLineName?: string;
  endStationId: string;
  endStationName?: string;
  /** Official field is misspelled `privice`. */
  privice?: number;
  ticketsVersion?: string;
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
  t?: string;
  r?: string;
  multilang?: { n?: { en?: string } };
}

export interface AmapLine {
  ln?: string;
  ls?: string;
  cl?: string;
  c?: string[];
  st?: AmapStation[];
  lb?: unknown;
}

export interface AmapSubway {
  s?: string;
  i?: string;
  l?: AmapLine[];
  o?: string;
}

export interface XianSources {
  lines: XianOfficialLine[];
  /** stationId → getStationInfo payload (may be empty when the feed omits times). */
  stationInfo: Map<string, XianStationInfo>;
  amap: AmapSubway;
  /** Optional pre-harvested OD fares keyed `${startId}|${endId}`. */
  fareSamples?: Map<string, number>;
  ticketsVersion?: string;
}

/** Snapshot dir (dev / blocked egress). Live APIs win when reachable. */
function snapshotDir(): string | undefined {
  return process.env.OPENMETRO_XIAN_SNAPSHOT;
}

async function readSnapshot<T>(name: string): Promise<T | undefined> {
  const dir = snapshotDir();
  if (!dir) return undefined;
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

async function saveSnapshot(name: string, value: unknown): Promise<void> {
  const dir = snapshotDir();
  if (!dir) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(value)}\n`, 'utf-8');
}

export async function fetchFindLineAll(): Promise<XianOfficialLine[]> {
  const snap = await readSnapshot<XianOfficialLine[]>('findLineAll.json');
  try {
    const data = await postJson<XianOfficialLine[]>(
      '/api-basicdata/lineStation/findLineAll',
      {}
    );
    if (Array.isArray(data) && data.length > 0) {
      await saveSnapshot('findLineAll.json', data);
      return data;
    }
  } catch (err) {
    console.log(`  findLineAll live failed (${err}); snapshot=${snap ? snap.length : 'none'}`);
  }
  if (snap && snap.length > 0) return snap;
  throw new Error('findLineAll unavailable live and no snapshot');
}

export async function fetchAmapSubway(): Promise<AmapSubway> {
  const snap = await readSnapshot<AmapSubway>('amap_6101.json');
  try {
    const data = await getJson<AmapSubway>(AMAP_SUBWAY, 'https://www.amap.com/', 3);
    if (data?.l?.length) {
      await saveSnapshot('amap_6101.json', data);
      return data;
    }
  } catch (err) {
    console.log(`  amap subway live failed (${err}); snapshot=${snap ? 'yes' : 'none'}`);
  }
  if (snap?.l?.length) return snap;
  throw new Error('AMap subway 6101 unavailable');
}

export async function fetchStationInfo(stationId: string): Promise<XianStationInfo> {
  const cacheName = `stationInfo-${stationId}.json`;
  try {
    const data = await getJson<XianStationInfo>(
      `${PAS}/api-web/aroundSite/getStationInfo?stationId=${encodeURIComponent(stationId)}`,
      `${SITE}/`,
      2
    );
    await saveSnapshot(cacheName, data);
    return data ?? {};
  } catch (err) {
    const snap = await readSnapshot<XianStationInfo>(cacheName);
    if (snap) return snap;
    console.log(`  getStationInfo ${stationId} failed: ${err}`);
    return {};
  }
}

/** Per-line timetable image metadata (not parsed — kept for provenance). */
export async function fetchTimetableImage(
  lineId: string
): Promise<{ filePath?: string; fileName?: string } | undefined> {
  try {
    return await postJson<{ filePath?: string; fileName?: string }>(
      '/api-operational/trainTimetable/findByLineId',
      { lineId, deployStatus: true }
    );
  } catch {
    return undefined;
  }
}

export async function fetchTicketPrice(
  startStationId: string,
  endStationId: string
): Promise<XianFareRow | undefined> {
  try {
    return await postJson<XianFareRow>('/api-operational/ticketPrice/findByStartAndEnd', {
      startStationId,
      endStationId
    });
  } catch {
    return undefined;
  }
}

/**
 * Official sources, fetched live when reachable (snapshot fallback keeps CI
 * and blocked-egress rebuilds working). No timetable OCR — structured
 * `getStationInfo.trainTime` only; lines the feed omits stay empty.
 */
export async function fetchXianSources(opts: { harvestStationInfo?: boolean } = {}) {
  const harvest = opts.harvestStationInfo !== false;
  console.log('  fetch official findLineAll');
  const lines = await fetchFindLineAll();
  console.log('  fetch AMap subway 6101');
  const amap = await fetchAmapSubway();

  const stationInfo = new Map<string, XianStationInfo>();
  const ids = lines.flatMap((l) => l.stations.map((s) => s.stationId));
  if (harvest) {
    console.log(`  fetch getStationInfo × ${ids.length}`);
    // Gentle parallelism — the gateway rate-limits aggressive bursts.
    const queue = [...ids];
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!id) break;
        const info = await fetchStationInfo(id);
        stationInfo.set(id, info);
        await sleep(80);
      }
    });
    await Promise.all(workers);
  } else {
    for (const id of ids) {
      const snap = await readSnapshot<XianStationInfo>(`stationInfo-${id}.json`);
      if (snap) stationInfo.set(id, snap);
    }
    console.log(`  stationInfo from snapshot: ${stationInfo.size}/${ids.length}`);
  }

  return { lines, stationInfo, amap } satisfies XianSources;
}
