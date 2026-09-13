/**
 * Station coordinates from OpenStreetMap via the Overpass API.
 *
 * The free fallback for stations the AMap subway dataset does not cover —
 * trams, intercity/regional rail and newly opened lines. OSM stores WGS84
 * coordinates, which are converted to GCJ-02 locally so they align with the
 * rest of the dataset. No API key is required.
 */
import { foldRareCharacters } from '../station-overrides.js';
import type { GeoResult } from './index.js';

const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'openmetro/0.1 (data enrichment)';
const DEFAULT_TIMEOUT_SEC = 90;

/** Overpass bounding box, ordered `[south, west, north, east]`. */
export type Bbox = [number, number, number, number];

export interface OverpassStation {
  /** Primary OSM name. */
  name: string;
  /** GCJ-02 coordinate, converted from OSM's WGS84. */
  location: GeoResult;
  /** Original WGS84 coordinate as stored in OSM. */
  wgs84: { lon: number; lat: number };
  /** OSM element reference, e.g. `node/123456`. */
  osmId: string;
  /** OSM `railway` tag value (`station`, `halt`, `tram_stop`). */
  railway?: string;
  /** OSM `station` tag value (`subway`, `light_rail`, `tram`, `train`, …). */
  station?: string;
  operator?: string;
  network?: string;
  /** Alternate names (`name:zh`, `name:en`, `alt_name`, …) for matching. */
  altNames: string[];
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

// ── WGS84 → GCJ-02 ──────────────────────────────────────────────

const PI = Math.PI;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.006693421622965943;

function outOfChina(lon: number, lat: number): boolean {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * Convert a WGS84 coordinate to GCJ-02 (the datum AMap and the rest of this
 * dataset use). Coordinates outside China are returned unchanged.
 */
export function wgs84ToGcj02(lon: number, lat: number): GeoResult {
  if (outOfChina(lon, lat)) return { lon, lat, crs: 'gcj02' };
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lon: lon + dLon, lat: lat + dLat, crs: 'gcj02' };
}

/** BD-09 (Baidu) extra twist over GCJ-02, in radians. */
const BD_X_PI = (PI * 3000.0) / 180.0;

/**
 * Convert a BD-09 (Baidu) coordinate to GCJ-02.
 *
 * Some official operator feeds publish Baidu coordinates under a plain
 * `longitude`/`latitude` pair; those must not be treated as GCJ-02.
 */
export function bd09ToGcj02(lon: number, lat: number): GeoResult {
  const x = lon - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * BD_X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_X_PI);
  return { lon: z * Math.cos(theta), lat: z * Math.sin(theta), crs: 'gcj02' };
}

/** Bounding box of `radiusKm` around a point. */
export function bboxAround(center: { lon: number; lat: number }, radiusKm: number): Bbox {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((center.lat * PI) / 180));
  return [center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon];
}

/** Tight bounding box around a set of points, optionally padded. */
export function bboxOf(points: { lon: number; lat: number }[], paddingDeg = 0): Bbox | undefined {
  if (points.length === 0) return undefined;
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  return [south - paddingDeg, west - paddingDeg, north + paddingDeg, east + paddingDeg];
}

// ── Query & fetch ───────────────────────────────────────────────

function buildQuery(bbox: Bbox, timeoutSec: number): string {
  const [south, west, north, east] = bbox;
  const box = `${south},${west},${north},${east}`;
  return (
    `[out:json][timeout:${timeoutSec}];(` +
    `node["railway"~"^(station|halt|tram_stop)$"]["name"](${box});` +
    `node["public_transport"="station"]["station"~"subway|light_rail|tram|train|monorail"]["name"](${box});` +
    `way["railway"~"^(station|halt|tram_stop)$"]["name"](${box});` +
    `);out center tags;`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postOverpass(query: string, retries = 3): Promise<OverpassResponse | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({ data: query })
      });
      // 429/504 are common under load; back off and retry.
      if (res.status === 429 || res.status === 504 || res.status >= 500) {
        throw new Error(`overpass ${res.status}`);
      }
      if (!res.ok) return undefined;
      return (await res.json()) as OverpassResponse;
    } catch {
      if (attempt >= retries) return undefined;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// ── Parsing ─────────────────────────────────────────────────────

function railKind(tags: Record<string, string>): string | undefined {
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.railway === 'tram_stop') {
    return tags.railway;
  }
  if (
    tags.public_transport === 'station' &&
    /subway|light_rail|tram|train|monorail/.test(tags.station ?? '')
  ) {
    return 'station';
  }
  return undefined;
}

const ALT_NAME_KEYS = [
  'name',
  'name:zh',
  'name:zh-Hans',
  'name:zh-Hant',
  'name:en',
  'alt_name',
  'official_name',
  'short_name'
];

function stationNames(
  tags: Record<string, string>
): { primary: string; alt: string[] } | undefined {
  const primary = tags.name ?? tags['name:zh'] ?? tags['name:zh-Hans'];
  if (!primary) return undefined;
  const all: string[] = [];
  for (const key of ALT_NAME_KEYS) {
    const v = tags[key];
    if (v && !all.includes(v)) all.push(v);
  }
  return { primary, alt: all.filter((n) => n !== primary) };
}

function parseOverpass(raw: OverpassResponse | undefined): OverpassStation[] {
  const out = new Map<string, OverpassStation>();
  for (const el of raw?.elements ?? []) {
    const tags = el.tags ?? {};
    const railway = railKind(tags);
    if (!railway) continue;

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const named = stationNames(tags);
    if (!named) continue;

    const osmId = `${el.type}/${el.id}`;
    const station: OverpassStation = {
      name: named.primary,
      location: wgs84ToGcj02(lon, lat),
      wgs84: { lon, lat },
      osmId,
      railway: tags.railway,
      station: tags.station,
      operator: tags.operator,
      network: tags.network,
      altNames: named.alt
    };

    const existing = out.get(named.primary);
    if (!existing) {
      out.set(named.primary, station);
    } else if (existing.osmId.startsWith('way/') && osmId.startsWith('node/')) {
      // Prefer the node: its coordinate is the mapped point, not an area centre.
      out.set(named.primary, station);
    }
  }
  return [...out.values()];
}

// ── Public API ──────────────────────────────────────────────────

/** Fetch stations within a bounding box directly from Overpass. */
export async function fetchOverpassStations(
  bbox: Bbox,
  opts: { timeoutSec?: number } = {}
): Promise<OverpassStation[]> {
  const query = buildQuery(bbox, opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
  return parseOverpass(await postOverpass(query));
}

/** Strip a trailing parenthetical, e.g. "广州塔（有轨）" -> "广州塔". */
function stripParenthetical(name: string): string {
  return name.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
}

/** Canonical matching form: no whitespace, decomposed rare characters folded. */
function normalizeName(name: string): string {
  return foldRareCharacters(name.replace(/\s+/g, ''));
}

/** All keys a name should be matchable under. */
function matchKeys(name: string): string[] {
  const keys = new Set<string>();
  for (const base of [name, stripParenthetical(name)]) {
    if (!base) continue;
    keys.add(base);
    keys.add(normalizeName(base));
  }
  return [...keys];
}

/**
 * Build a name -> station lookup covering the primary name, every alternate
 * name, and their normalized forms.
 */
export function indexOverpassStations(stations: OverpassStation[]): Map<string, OverpassStation> {
  const index = new Map<string, OverpassStation>();
  const add = (key: string, station: OverpassStation) => {
    if (key && !index.has(key)) index.set(key, station);
  };
  for (const st of stations) {
    for (const name of [st.name, ...st.altNames]) {
      for (const key of matchKeys(name)) add(key, st);
    }
  }
  return index;
}

/** Look up a station by an official Chinese name. */
export function findOverpassStation(
  index: Map<string, OverpassStation>,
  name: string
): OverpassStation | undefined {
  for (const key of matchKeys(name)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return undefined;
}
