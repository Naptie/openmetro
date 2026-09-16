import { cityBbox, isWithinCityBbox } from './city-bbox.js';
import { isCoarseCoordinate, isConsistentWithLine } from './consistency.js';
import {
  type Bbox,
  bboxAround,
  bboxOf,
  fetchOverpassStations,
  findOverpassStation,
  indexOverpassStations,
  type OverpassStation
} from './overpass.js';
import { geocodeViaPhoton } from './photon.js';
import {
  fetchSubwayStations,
  findSubwayStation,
  indexSubwayStations,
  type SubwayStation
} from './subway.js';
import type { KnownLocation } from './transform.js';

export { CITY_BBOX, cityBbox, isWithinCityBbox } from './city-bbox.js';
export {
  haversineKm,
  isCoarseCoordinate,
  isConsistentWithLine,
  MAX_NEAREST_KM,
  maxNearestKm,
  nearestSameLinePeerKm
} from './consistency.js';
export {
  type Bbox,
  bboxAround,
  bboxOf,
  bd09ToGcj02,
  fetchOverpassStations,
  findOverpassStation,
  indexOverpassStations,
  type OverpassStation,
  wgs84ToGcj02
} from './overpass.js';
export { geocodeViaPhoton } from './photon.js';
export { officialFetchHeaders, proxyUrl } from './proxy.js';
export {
  fetchSubwayStations,
  findSubwayStation,
  indexSubwayStations,
  type SubwayStation
} from './subway.js';

export interface GeoResult {
  lon: number;
  lat: number;
  crs: 'gcj02';
}

export interface LonLat {
  lon: number;
  lat: number;
}

/** Inject free-geocoder fetchers for tests; defaults to the network fetchers. */
export interface GeocodeFetchers {
  fetchSubway?: (city: string) => Promise<SubwayStation[]>;
  fetchOverpass?: (bbox: Bbox) => Promise<OverpassStation[]>;
  geocode?: (
    name: string,
    city: string,
    center?: { lon: number; lat: number }
  ) => Promise<GeoResult | undefined>;
}

/** A coordinate in any datum; geocoding reads only `lon`/`lat`. */
type StationLocation = { lon: number; lat: number; crs: string };

interface StationLike {
  id: string;
  name?: string;
  names?: { zh?: string };
  location?: StationLocation;
  extras?: Record<string, unknown>;
}

interface StopRef {
  station_id: string;
  line_id: string;
  sequence?: number;
}

interface LineRef {
  id: string;
  mode: string;
}

function stationName(st: StationLike): string {
  return st.names?.zh ?? st.name ?? '';
}

function buildStopMaps(stops: StopRef[] | undefined) {
  const stopsByStation = new Map<string, string[]>();
  const stopsByLine = new Map<string, string[]>();
  if (!stops) return { stopsByStation, stopsByLine };
  for (const stop of stops) {
    const bySt = stopsByStation.get(stop.station_id) ?? [];
    if (!bySt.includes(stop.line_id)) bySt.push(stop.line_id);
    stopsByStation.set(stop.station_id, bySt);
    const byLine = stopsByLine.get(stop.line_id) ?? [];
    byLine.push(stop.station_id);
    stopsByLine.set(stop.line_id, byLine);
  }
  return { stopsByStation, stopsByLine };
}

/**
 * Resolve station coordinates from multiple free sources with cross-validation.
 *
 * Cascade:
 *  1. AMap subway — free, strongest for metro.
 *  2. Official operator coords (`officialLocations`) — only when in-city and
 *     consistent with same-line peers.
 *  3. Overpass — free; same consistency rule (avoids same-name misses).
 *  4. Photon — free forward geocode, city-biased.
 *
 * `stops` + `lines` enable same-line peer checks. Without them only the
 * city bbox filter applies.
 */
export async function fillCoordinates<T extends StationLike>(
  stations: T[],
  opts: {
    city: string;
    extraCities?: string[];
    stops?: StopRef[];
    lines?: LineRef[];
    /** Official/operator coords keyed by station id (preferred) or Chinese name. */
    officialLocations?: Map<string, GeoResult> | Record<string, GeoResult>;
    /** Hand-verified coords that override any geocoder; highest priority. */
    knownLocations?: KnownLocation[];
    /** Injectable geocoder fetchers (used by tests). */
    fetchers?: GeocodeFetchers;
    concurrency?: number;
    delayMs?: number;
    bbox?: Bbox;
    bboxPaddingDeg?: number;
    center?: [number, number];
    radiusKm?: number;
    onSubwayMatch?: (name: string) => void;
    onOfficialMatch?: (name: string) => void;
    onOverpassMatch?: (name: string) => void;
    onGeocode?: (name: string) => void;
    onKnownMatch?: (name: string) => void;
  }
): Promise<T[]> {
  const cities = [opts.city, ...(opts.extraCities ?? [])];
  const cityCenter = cityBbox(opts.city)?.center;
  const { stopsByStation, stopsByLine } = buildStopMaps(opts.stops);
  const modeByLine = new Map((opts.lines ?? []).map((l) => [l.id, l.mode]));
  const fetchers = opts.fetchers ?? {};
  const fetchSubway = fetchers.fetchSubway ?? fetchSubwayStations;
  const fetchOverpass = fetchers.fetchOverpass ?? fetchOverpassStations;
  const geocode = fetchers.geocode ?? geocodeViaPhoton;
  const official =
    opts.officialLocations instanceof Map
      ? opts.officialLocations
      : new Map(Object.entries(opts.officialLocations ?? {}));

  /** id → location, updated as we accept candidates. */
  const placed = new Map<string, StationLocation>();

  /** Set a station's location and record its provenance in extras. */
  const setLocation = (st: T, loc: StationLocation, source: string) => {
    st.location = loc;
    st.extras = { ...(st.extras ?? {}), location_source: source };
    placed.set(st.id, loc);
  };

  const accept = (
    st: T,
    loc: GeoResult,
    source: 'official' | 'overpass' | 'photon',
    peerPool: Map<string, StationLocation> = placed
  ) => {
    if (!isWithinCityBbox(opts.city, loc.lon, loc.lat)) return false;
    if (isCoarseCoordinate(loc.lon, loc.lat)) return false;
    if (
      !isConsistentWithLine(
        st.id,
        loc,
        peerPool,
        stopsByStation,
        stopsByLine,
        modeByLine,
        stopsByStation.get(st.id) ?? []
      )
    ) {
      return false;
    }
    setLocation(st, loc, source);
    if (source === 'official') opts.onOfficialMatch?.(stationName(st));
    else if (source === 'overpass') opts.onOverpassMatch?.(stationName(st));
    else opts.onGeocode?.(stationName(st));
    return true;
  };

  // ── 0. Hand-verified known locations ──────────────────────────
  // These override any geocoder (including AMap subway), so a manually
  // confirmed coordinate is always selected and its provenance recorded.
  // Names are pre-folded by the adapter, so the core matches directly.
  const knownByName = new Map<string, KnownLocation>();
  for (const k of opts.knownLocations ?? []) {
    knownByName.set(k.name, k);
  }
  for (const st of stations) {
    const name = stationName(st);
    const known = name ? knownByName.get(name) : undefined;
    if (known) {
      // Hand-verified coordinates win over any geocoder or pre-seeded value.
      setLocation(st, known.location, known.source);
      opts.onKnownMatch?.(stationName(st));
    }
  }

  // ── 1. AMap subway ────────────────────────────────────────────
  const indices = await Promise.all(
    cities.map(async (c) => indexSubwayStations(await fetchSubway(c)))
  );
  // Count stations sharing a Chinese name so homonyms that were split into
  // distinct physical stations (and carry id-keyed official coords) are not
  // collapsed again by a bare-name AMap hit.
  const nameCounts = new Map<string, number>();
  for (const st of stations) {
    const n = stationName(st);
    if (n) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }
  for (const st of stations) {
    if (placed.has(st.id)) continue; // known locations already placed in step 0
    if (st.location) continue; // pre-seeded: validated/kept as 'source' in the drop loop
    const name = stationName(st);
    if (!name) continue;
    // Split same-name platforms: prefer station-id official coords over the
    // first AMap bare-name hit (e.g. 浦东南路 Line 2 vs Line 14).
    if (official.has(st.id) && (nameCounts.get(name) ?? 0) > 1) continue;
    for (const idx of indices) {
      const hit = findSubwayStation(idx, name);
      if (hit) {
        setLocation(st, hit.location, 'subway');
        opts.onSubwayMatch?.(stationName(st));
        break;
      }
    }
  }

  // ── 2. Official operator coords ───────────────────────────────
  // Validate against the full same-line candidate set (placed ∪ other
  // official hits), not only already-accepted stations — otherwise a
  // terminus rejects itself against the far end of a long intercity line.
  // Coarse (2-decimal, ~1 km) official coords are treated as missing.
  const officialCandidates = new Map<string, GeoResult>();
  for (const st of stations) {
    const name = stationName(st);
    const off = official.get(st.id) ?? (name ? official.get(name) : undefined);
    if (!off) continue;
    if (!isWithinCityBbox(opts.city, off.lon, off.lat)) continue;
    if (isCoarseCoordinate(off.lon, off.lat)) continue;
    officialCandidates.set(st.id, off);
  }
  for (const st of stations) {
    if (st.location) continue;
    const off = officialCandidates.get(st.id);
    if (!off) continue;
    const peerPool = new Map(placed);
    for (const [id, loc] of officialCandidates) {
      if (id !== st.id && !peerPool.has(id)) peerPool.set(id, loc);
    }
    accept(st, off, 'official', peerPool);
  }

  // Drop pre-seeded locations that are coarse, out of city, or conflict with subway data.
  for (const st of stations) {
    if (!st.location) continue;
    if (placed.has(st.id)) continue;
    const name = stationName(st);
    const subwayHit = (() => {
      for (const idx of indices) {
        const hit = findSubwayStation(idx, name);
        if (hit) return hit.location;
      }
      return undefined;
    })();
    if (subwayHit) {
      if (
        !isCoarseCoordinate(subwayHit.lon, subwayHit.lat) &&
        isWithinCityBbox(opts.city, subwayHit.lon, subwayHit.lat)
      ) {
        st.location = undefined;
        setLocation(st, subwayHit, 'subway');
        opts.onSubwayMatch?.(stationName(st));
        continue;
      }
    }
    if (
      isCoarseCoordinate(st.location.lon, st.location.lat) ||
      !isWithinCityBbox(opts.city, st.location.lon, st.location.lat)
    ) {
      st.location = undefined;
      continue;
    }
    // Survived validation: it is a source-feed coordinate (not a geocoder).
    setLocation(st, st.location, 'source');
  }

  // ── 3. Overpass ───────────────────────────────────────────────
  if (stations.some((st) => !st.location && stationName(st))) {
    const known = [...placed.values()];
    const bbox =
      opts.bbox ??
      bboxOf(known, opts.bboxPaddingDeg ?? 0.75) ??
      (opts.center
        ? bboxAround({ lon: opts.center[0], lat: opts.center[1] }, opts.radiusKm ?? 60)
        : cityCenter
          ? bboxAround(cityCenter, 80)
          : undefined);
    if (bbox) {
      const overpass = indexOverpassStations(await fetchOverpass(bbox));
      for (const st of stations) {
        if (st.location) continue;
        const name = stationName(st);
        const hit = name ? findOverpassStation(overpass, name) : undefined;
        if (hit) accept(st, hit.location, 'overpass');
      }
    }
  }

  // ── 4. Photon ─────────────────────────────────────────────────
  for (const st of stations) {
    if (st.location) continue;
    const name = stationName(st);
    if (!name) continue;
    for (const city of cities) {
      const center = cityBbox(city)?.center ?? cityCenter;
      const hit = await geocode(name, city, center);
      if (hit) {
        // Photon is biased per city name; accept only if in the primary city bbox.
        if (accept(st, hit, 'photon')) break;
      }
    }
  }

  return stations;
}

export type {
  KnownLocation,
  LocatableStation,
  TransformStations,
  TransformStationsContext
} from './transform.js';
