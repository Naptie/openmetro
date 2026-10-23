/**
 * Official Ningbo Rail Transit (宁波轨道交通) sources.
 *
 * The operator publishes its whole network as one unauthenticated JSON feed:
 *
 *   GET http://www.nbmetro.com/station.php?stat
 *     → one entry per line: the ordered station list, the per-direction
 *       first/last train times, the interchange marker (`intro`) and — for
 *       interchange stations — the partner line's own direction and times
 *       (`dfx*` / `dsbc*` / `dmbc*`).
 *
 *   GET http://www.nbmetro.com/station.php?gostationTest/<from>/<to>/<strategy>
 *     → the official route as a list of station ids, the interchange stations
 *       on that route (`hc`) and the official fare in CNY (`price`).
 *       `strategy` 1 = shortest time, 2 = fewest transfers.
 *
 * HTTPS is deliberately not used: the operator's certificate has expired
 * (`SEC_E_CERT_EXPIRED`), so every request has to go over plain HTTP.
 *
 * `station.php` is a PHP pseudo-router — the part after `?` is a *path*, not a
 * query string, so it must not be URL-encoded.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const NB_SITE = 'http://www.nbmetro.com';
export const NB_STATION_API = `${NB_SITE}/station.php?stat`;
export const NB_ROUTE_API = `${NB_SITE}/station.php?gostationTest`;
export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3302_drw_ningbo.json';
export const AMAP_REFERER = 'http://www.nbmetro.com/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, referer?: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders(referer ? { Referer: referer } : {}),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
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

/** One station row of the official feed. */
export interface NbStationRecord {
  /** Official station id — shared by every line the station belongs to. */
  id: string;
  /** Chinese station name. */
  title: string;
  /** `"1"` marks an interchange station; empty otherwise. */
  intro: string | null;
  /** Destination of direction 1 / 2 (terminal station name). */
  fx1: string | null;
  fx2: string | null;
  /** First / last train of direction 1 / 2. */
  sbc1: string | null;
  mbc1: string | null;
  sbc2: string | null;
  mbc2: string | null;
  /** Destination of the *other* line at an interchange station. */
  dfx1: string | null;
  dfx2: string | null;
  /** First / last train of the other line at an interchange station. */
  dsbc1: string | null;
  dmbc1: string | null;
  dsbc2: string | null;
  dmbc2: string | null;
  /** Line number of the other line at an interchange station (sometimes null). */
  type: string | null;
}

export interface NbLineRecord {
  /** Line number as published by the operator (`1` … `12`). */
  type: string;
  /** Stations in running order. */
  station: NbStationRecord[];
}

export interface AmapStation {
  /** Chinese name. */
  n?: string;
  /** English name (real English where the operator published one). */
  en?: string;
  /** Pinyin. */
  sp?: string;
  /** `"lon,lat"` in GCJ-02. */
  sl?: string;
  /** Schematic pixel coordinates. */
  p?: string;
  /** Route segment pixel coordinates. */
  rs?: string;
  /** AMap POI id. */
  poiid?: string;
  /** Interchange marker. */
  t?: string;
}

export interface AmapLine {
  /** Display name (`轨道交通1号线`). */
  ln?: string;
  /** Short name (`轨道交通1号线`). */
  kn?: string;
  /** Line colour as `#rrggbb`. */
  cl?: string;
  /** English name (`Line 1`). */
  ek?: string;
  ea?: string;
  /** Line id(s), `|` separated. */
  li?: string;
  st?: AmapStation[];
}

export interface AmapSubwayDoc {
  /** City name. */
  s?: string;
  /** AMap adcode. */
  i?: string;
  l?: AmapLine[];
}

export interface NingboSources {
  /** Official topology + timetables. */
  official: NbLineRecord[];
  /** AMap subway map (coordinates, schematic, colours, English names). */
  amapSubway: AmapSubwayDoc;
}

/** Official route + fare query. */
export interface NbRouteEnvelope {
  code: string;
  message: string;
  /** Station ids along the official route. */
  data: string[];
  /** Interchange stations on the route. */
  hc: string[];
  /** Official fare in CNY (string). */
  price: string | number | null;
}

/** Fetch the official topology + timetable feed and the AMap subway dataset. */
export async function fetchNingboSources(): Promise<NingboSources> {
  console.log('  fetch nbmetro station.php?stat');
  const official = await getJson<NbLineRecord[]>(NB_STATION_API, NB_SITE);
  if (!Array.isArray(official) || official.length === 0) {
    throw new Error('nbmetro station feed returned no lines');
  }
  console.log('  fetch AMap subway 3302_drw_ningbo.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  return { official, amapSubway };
}

/**
 * Official route and fare between two stations.
 *
 * @param from official station id
 * @param to official station id
 * @param strategy 1 = shortest time, 2 = fewest transfers
 */
export async function fetchNingboRoute(
  from: string,
  to: string,
  strategy: 1 | 2 = 1
): Promise<NbRouteEnvelope> {
  return getJson<NbRouteEnvelope>(`${NB_ROUTE_API}/${from}/${to}/${strategy}`, NB_SITE, 3);
}
