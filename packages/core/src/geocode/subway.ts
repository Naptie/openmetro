/**
 * Station coordinates from AMap's subway-map dataset.
 *
 * The AMap subway map (map.amap.com/subway) is backed by a plain static JSON
 * keyed by city. It exposes every core-network station with a Chinese name and
 * GCJ-02 coordinates, needs no API key and no request signing, and — unlike
 * name-matching POI search — resolves stations unambiguously.
 *
 * It covers metro systems only: tram/light-rail and intercity lines are absent,
 * so callers should still fall back to the POI geocoder for unmatched stations.
 */
import type { GeoResult } from './index.js';

const SUBWAY_URL = 'https://map.amap.com/service/subway';
const USER_AGENT = 'Mozilla/5.0 (compatible; openmetro/0.1)';

interface CityEntry {
  spell: string;
  adcode: string;
  cityname: string;
}

interface RawStation {
  n?: string;
  sp?: string;
  sl?: string;
  poiid?: string;
}

interface RawLine {
  ln?: string;
  st?: RawStation[];
}

interface RawSubway {
  s?: string;
  i?: string;
  l?: RawLine[];
}

export interface SubwayStation {
  /** Chinese station name as published by AMap. */
  name: string;
  /** AMap pinyin/romanised name (e.g. "XinZha Lu"). */
  pinyin?: string;
  /** AMap POI id, stable across runs. */
  poiid?: string;
  /** GCJ-02 coordinate. */
  location: GeoResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a JSON document with a few retries on transient failures. */
async function getJson<T>(url: string, retries = 3): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`amap subway ${res.status}`);
      return (await res.json()) as T;
    } catch {
      if (attempt >= retries) return undefined;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** Drop a trailing "市" so "上海市" and "上海" resolve to the same city. */
function normalizeCity(city: string): string {
  return city.replace(/市$/, '').trim();
}

let cityListPromise: Promise<CityEntry[]> | undefined;

/** Fetch (once per process) the AMap subway city list. */
function loadCityList(): Promise<CityEntry[]> {
  cityListPromise ??= getJson<{ citylist?: CityEntry[] }>(
    `${SUBWAY_URL}?srhdata=citylist.json`
  ).then((data) => data?.citylist ?? []);
  return cityListPromise;
}

/** Resolve a Chinese city name to its AMap subway city entry. */
async function resolveCity(city: string): Promise<CityEntry | undefined> {
  const target = normalizeCity(city);
  const list = await loadCityList();
  return list.find(
    (c) => normalizeCity(c.cityname) === target || c.spell.toLowerCase() === target.toLowerCase()
  );
}

function parseSl(sl: string | undefined): GeoResult | undefined {
  if (!sl) return undefined;
  const [lon, lat] = sl.split(',').map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat, crs: 'gcj02' } : undefined;
}

/** Flatten the per-line station arrays into one entry per distinct station. */
function parseSubway(raw: RawSubway | undefined): SubwayStation[] {
  if (!raw?.l) return [];
  const out = new Map<string, SubwayStation>();
  for (const line of raw.l) {
    for (const st of line.st ?? []) {
      const name = st.n?.trim();
      if (!name || out.has(name)) continue;
      const location = parseSl(st.sl);
      if (!location) continue;
      out.set(name, { name, pinyin: st.sp, poiid: st.poiid, location });
    }
  }
  return [...out.values()];
}

async function fetchRaw(city: string): Promise<RawSubway | undefined> {
  const entry = await resolveCity(city);
  if (!entry) return undefined;
  return getJson<RawSubway>(`${SUBWAY_URL}?srhdata=${entry.adcode}_drw_${entry.spell}.json`);
}

/** Fetch the AMap subway stations for a city directly from the network. */
export async function fetchSubwayStations(city: string): Promise<SubwayStation[]> {
  return parseSubway(await fetchRaw(city));
}

/** Strip a trailing parenthetical, e.g. "国家会展中心(2号线)" -> "国家会展中心". */
function stripParenthetical(name: string): string {
  return name.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
}

/**
 * Build a name -> station lookup. Both exact and parenthetical-stripped keys
 * are indexed so official names without parentheses can still hit AMap's
 * line-disambiguated variants (e.g. 国家会展中心 -> 国家会展中心(2号线)).
 */
export function indexSubwayStations(stations: SubwayStation[]): Map<string, SubwayStation> {
  const index = new Map<string, SubwayStation>();
  for (const st of stations) {
    if (!index.has(st.name)) index.set(st.name, st);
    const bare = stripParenthetical(st.name);
    if (bare && !index.has(bare)) index.set(bare, st);
  }
  return index;
}

/**
 * Look up a station by its official Chinese name, exact match only.
 *
 * The query is intentionally NOT parenthetical-stripped: AMap's subway dataset
 * is metro-only, so stripping would pin intercity/tram twins like 陈村(城际)
 * onto the metro POI 陈村 (0 m collision). AMap-side index stripping remains
 * so bare official names still resolve line-suffixed AMap entries.
 */
export function findSubwayStation(
  index: Map<string, SubwayStation>,
  name: string
): SubwayStation | undefined {
  return index.get(name);
}
