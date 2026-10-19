import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeedStation } from './feed.js';
import { fetchFeedText } from './feed.js';
import { adapterCacheDir } from './paths.js';

interface OsmStation {
  type: string;
  id: number;
  lon: number;
  lat: number;
  tags?: Record<string, string>;
}
export interface OsmFeed {
  elements: OsmStation[];
  osm3s?: { timestamp_osm_base?: string };
  remark?: string;
}

type Bounds = [number, number, number, number];

function enrichmentTiles([south, west, north, east]: Bounds): Bounds[] {
  if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east)
    throw new Error('Invalid OSM enrichment bounding box');
  const rows = Math.ceil((north - south) / 0.15);
  const columns = Math.ceil((east - west) / 0.2);
  if (rows * columns > 64)
    throw new Error('OSM enrichment bounding box requires more than 64 tiles');
  const latitude = (row: number) => Number((south + ((north - south) * row) / rows).toFixed(7));
  const longitude = (column: number) =>
    Number((west + ((east - west) * column) / columns).toFixed(7));
  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns),
      column = index % columns;
    return [latitude(row), longitude(column), latitude(row + 1), longitude(column + 1)];
  });
}

/** Supplement operator station identities with explicitly attributed OSM names/coordinates. */
export function enrichFeedStations(stations: FeedStation[], osm: OsmFeed): FeedStation[] {
  const fold = (s: string) => s.replaceAll('臺', '台').replace(/站$/, '').replace(/\s+/g, '');
  return stations.map((s) => {
    const hit =
      osm.elements.find((e) => e.tags?.ref?.split(/[;,]/).includes(s.code)) ??
      osm.elements.find((e) =>
        [e.tags?.name, e.tags?.['name:zh'], e.tags?.['name:zh-Hant']].some(
          (n) => n && fold(n) === fold(s.zh)
        )
      );
    const named = osm.elements.find(
      (e) =>
        e.tags?.['name:en'] &&
        [e.tags?.name, e.tags?.['name:zh']].some((n) => n && fold(n) === fold(s.zh))
    );
    const en = s.en || hit?.tags?.['name:en']?.trim() || named?.tags?.['name:en']?.trim();
    if (!en) throw new Error(`No English name for ${s.code} (${s.zh}); enrichment incomplete`);
    if (!hit && !s.location)
      throw new Error(`No coordinates for ${s.code} (${s.zh}); enrichment incomplete`);
    return {
      ...s,
      en,
      location: s.location ?? { lon: hit!.lon, lat: hit!.lat, crs: 'wgs84' as const },
      source: s.source,
      extras: {
        ...s.extras,
        location_source: s.location ? 'official' : 'overpass',
        english_name_source: s.en ? 'official' : 'osm'
      },
      enrichment_id: hit ? `${hit.type}/${hit.id}` : undefined
    };
  });
}

export async function fetchFeedEnrichment(bbox: Bounds): Promise<OsmFeed> {
  const day = 24 * 60 * 60 * 1000;
  const sourceAge = (raw: OsmFeed) => {
    const now = Date.now();
    const timestamp = Date.parse(raw.osm3s?.timestamp_osm_base ?? '');
    if (
      !Number.isFinite(timestamp) ||
      timestamp > now + 5 * 60 * 1000 ||
      now - timestamp > 30 * day
    )
      throw new Error(
        'OSM source timestamp is missing, invalid or older than 30 days; fetch a current raw snapshot'
      );
    return now - timestamp;
  };
  const dir = adapterCacheDir('enrichment'),
    file = join(dir, `overpass-${bbox.join('_')}.json`);
  const decode = (text: string, bounds = bbox, requireComplete = false): OsmFeed => {
    const raw = JSON.parse(text) as OsmFeed;
    if (!raw || !Array.isArray(raw.elements))
      throw new Error('Invalid OSM station enrichment response');
    if ('remark' in raw) throw new Error(`Incomplete OSM response (remark): ${String(raw.remark)}`);
    if (raw.elements.some((element) => !element || typeof element !== 'object'))
      throw new Error('Invalid OSM station enrichment element');
    const counts = raw.elements.filter((element) => element.type === 'count');
    const nodes = raw.elements.filter((element) => element.type !== 'count');
    if (requireComplete || counts.length) {
      const count = counts[0];
      if (
        counts.length !== 1 ||
        raw.elements.at(-1) !== count ||
        count?.tags?.nodes !== String(nodes.length) ||
        count.tags.total !== String(nodes.length) ||
        count.tags.ways !== '0' ||
        count.tags.relations !== '0'
      )
        throw new Error('Incomplete OSM response: missing or mismatched completion count');
    }
    if (
      nodes.some(
        (element) =>
          element.type !== 'node' ||
          !Number.isSafeInteger(element.id) ||
          !Number.isFinite(element.lon) ||
          !Number.isFinite(element.lat)
      )
    )
      throw new Error('Invalid OSM station enrichment node');
    const [south, west, north, east] = bounds;
    const elements = nodes.filter(
      (e) => e.lon >= west && e.lon <= east && e.lat >= south && e.lat <= north
    );
    if (requireComplete && elements.length !== nodes.length)
      throw new Error('Incomplete OSM tile: response contains nodes outside the requested bounds');
    if (!requireComplete && !elements.length)
      throw new Error('Empty OSM station enrichment feed for this bounding box');
    sourceAge(raw);
    return { ...raw, elements };
  };
  const save = async (raw: OsmFeed) => {
    await mkdir(dir, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(raw));
    await rename(temporary, file);
  };
  let cached: { raw: OsmFeed; age: number } | undefined;
  try {
    cached = {
      raw: decode(await readFile(file, 'utf8')),
      age: Date.now() - (await stat(file)).mtimeMs
    };
  } catch {}
  // A previously downloaded raw Overpass snapshot permits reproducible/offline enrichment.
  // Official operator feeds are still fetched live; this never reads canonical data back as input.
  if (process.env.OPENMETRO_OSM_FILE) {
    const raw = decode(await readFile(process.env.OPENMETRO_OSM_FILE, 'utf8'));
    await save(raw);
    return raw;
  }
  if (cached && cached.age < day && sourceAge(cached.raw) < day) return cached.raw;
  // A comma-separated override supports private mirrors without contacting public servers.
  const endpoints = process.env.OVERPASS_URL?.trim()
    ? process.env.OVERPASS_URL.split(',')
        .map((url) => url.trim())
        .filter(Boolean)
    : [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.private.coffee/api/interpreter'
      ];
  if (!endpoints.length || endpoints.length > 3)
    throw new Error('Configure one to three Overpass endpoints');
  const cannotRetry = (error: unknown) => {
    const responseError = error as { permanent?: boolean; status?: number };
    return responseError.permanent || responseError.status === 429;
  };
  const fetchRegion = async (bounds: Bounds): Promise<OsmFeed> => {
    const query = `[out:json][timeout:20];node["railway"="station"](${bounds.join(',')});out;out count;`;
    let failure: unknown;
    for (const endpoint of endpoints) {
      try {
        const raw = decode(
          await fetchFeedText(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json'
            },
            // Let fetchFeedText give each retry its own request deadline.
            body: new URLSearchParams({ data: query }).toString()
          }),
          bounds,
          true
        );
        // Prefer the successful mirror for the rest of this bounded download.
        endpoints.splice(endpoints.indexOf(endpoint), 1);
        endpoints.unshift(endpoint);
        return raw;
      } catch (error) {
        failure = error;
        // Bad requests, denied access and rate limits must not be routed around.
        if (cannotRetry(error)) throw error;
      }
    }
    throw failure;
  };
  try {
    const tiles = enrichmentTiles(bbox);
    const parts: OsmFeed[] = [];
    try {
      parts.push(await fetchRegion(bbox));
    } catch (error) {
      if (tiles.length === 1 || cannotRetry(error)) throw error;
      // Only subdivide failed whole-region queries; keep requests sequential and bounded.
      for (const bounds of tiles) parts.push(await fetchRegion(bounds));
    }
    const elements = new Map<string, OsmStation>();
    for (const part of parts)
      for (const element of part.elements) elements.set(`${element.type}/${element.id}`, element);
    if (!elements.size) throw new Error('Empty OSM station enrichment feed for this bounding box');
    const oldest = parts
      .map((part) => part.osm3s!.timestamp_osm_base!)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    const raw: OsmFeed = {
      ...parts[0],
      osm3s: { ...parts[0]!.osm3s, timestamp_osm_base: oldest },
      elements: [...elements.values()].sort((a, b) => a.id - b.id)
    };
    await save(raw);
    return raw;
  } catch (error) {
    if (cached && cached.age < 30 * day && sourceAge(cached.raw) < 30 * day) {
      console.warn(
        'Overpass unavailable; using the last successful enrichment snapshot with its original source timestamp.'
      );
      return cached.raw;
    }
    throw error;
  }
}
