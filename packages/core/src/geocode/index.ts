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
  evaluateStationSpeed,
  formatSpeedReport,
  type LineModeRef,
  type SegmentAdjacency,
  type StationSpeedReport
} from './speed-validate.js';
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
  evaluateNetworkSpeeds,
  evaluateStationSpeed,
  formatSpeedReport,
  type LineModeRef,
  type LocatableLike,
  MODE_MAX_SPEED_KMH,
  meanLeaveOneOutSpeedKmh,
  modeMaxSpeedKmh,
  type SegmentAdjacency,
  SPEED_VALIDATE,
  type SpeedViolation,
  type StationSpeedReport,
  UNTRUSTED_TIME_SOURCES
} from './speed-validate.js';
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
    /** Adjacent-stop travel times; enables leave-one-out speed validation. */
    segments?: SegmentAdjacency[];
    /**
     * After the cascade assignment, re-check each station against leave-one-out
     * segment speeds and fall back through remaining sources until the
     * coordinate passes. Throws when no candidate source is acceptable.
     */
    speedValidate?: boolean;
    /** Default true when `speedValidate` is on. */
    failOnInvalidCoordinates?: boolean;
    onSpeedValidate?: (report: StationSpeedReport) => void;
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

  /** All discovered source candidates per station, used by speed fallback. */
  const candidates = new Map<string, { source: string; location: GeoResult }[]>();
  const addCandidate = (st: T, loc: { lon: number; lat: number; crs?: string }, source: string) => {
    const list = candidates.get(st.id) ?? [];
    if (list.some((c) => c.source === source)) return;
    list.push({
      source,
      location: { lon: loc.lon, lat: loc.lat, crs: 'gcj02' }
    });
    candidates.set(st.id, list);
  };

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
    addCandidate(st, loc, source);
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
      addCandidate(st, known.location, known.source);
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
    const name = stationName(st);
    if (!name) continue;
    // Split same-name platforms: prefer station-id official coords over the
    // first AMap bare-name hit (e.g. 浦东南路 Line 2 vs Line 14).
    const skipAssignForHomonym = official.has(st.id) && (nameCounts.get(name) ?? 0) > 1;
    for (const idx of indices) {
      const hit = findSubwayStation(idx, name);
      if (!hit) continue;
      if (!isCoarseCoordinate(hit.location.lon, hit.location.lat)) {
        addCandidate(st, hit.location, 'subway');
      }
      const alreadyPlaced = placed.has(st.id) || !!st.location;
      if (!alreadyPlaced && !skipAssignForHomonym) {
        setLocation(st, hit.location, 'subway');
        opts.onSubwayMatch?.(stationName(st));
      }
      break;
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
    const off = officialCandidates.get(st.id);
    if (!off) continue;
    addCandidate(st, off, 'official');
    if (st.location) continue;
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
        addCandidate(st, subwayHit, 'subway');
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
    addCandidate(st, st.location, 'source');
    setLocation(st, st.location, 'source');
  }

  // ── 3. Overpass ───────────────────────────────────────────────
  // Fetch whenever stations remain unplaced OR speed validation needs
  // fallback candidates beyond the cascade winner.
  const needOverpass =
    opts.speedValidate === true || stations.some((st) => !st.location && stationName(st));
  if (needOverpass) {
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
        const name = stationName(st);
        const hit = name ? findOverpassStation(overpass, name) : undefined;
        if (!hit) continue;
        if (
          isCoarseCoordinate(hit.location.lon, hit.location.lat) ||
          !isWithinCityBbox(opts.city, hit.location.lon, hit.location.lat)
        ) {
          continue;
        }
        addCandidate(st, hit.location, 'overpass');
        if (!st.location) accept(st, hit.location, 'overpass');
      }
    }
  }

  // ── 4. Photon ─────────────────────────────────────────────────
  // Only unplaced stations during the cascade; speed fallback queries photon
  // lazily when a station has exhausted higher-priority candidates.
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

  // ── 5. Leave-one-out speed validation + source fallback ───────
  if (opts.speedValidate && opts.segments?.length) {
    await speedValidateWithFallback(stations, {
      segments: opts.segments,
      candidates,
      lines: opts.lines,
      cities,
      city: opts.city,
      cityCenter,
      geocode,
      failOnInvalid: opts.failOnInvalidCoordinates !== false,
      onSpeedValidate: opts.onSpeedValidate,
      setLocation
    });
  }

  return stations;
}

const CASCADE_SOURCE_ORDER = [
  'known',
  'subway',
  'source',
  'official',
  'overpass',
  'osm',
  'photon'
] as const;

function sourcePriority(source: string): number {
  const i = CASCADE_SOURCE_ORDER.indexOf(source as (typeof CASCADE_SOURCE_ORDER)[number]);
  return i >= 0 ? i : CASCADE_SOURCE_ORDER.length;
}

async function speedValidateWithFallback<T extends StationLike>(
  stations: T[],
  ctx: {
    segments: SegmentAdjacency[];
    candidates: Map<string, { source: string; location: GeoResult }[]>;
    lines?: LineModeRef[];
    cities: string[];
    city: string;
    cityCenter?: { lon: number; lat: number };
    geocode: NonNullable<GeocodeFetchers['geocode']>;
    failOnInvalid: boolean;
    onSpeedValidate?: (report: StationSpeedReport) => void;
    setLocation: (st: T, loc: StationLocation, source: string) => void;
  }
): Promise<void> {
  const byId = new Map(stations.map((s) => [s.id, s]));
  /** Sources already rejected by speed validation for a station. */
  const rejected = new Map<string, Set<string>>();
  const reject = (stationId: string, source: string) => {
    const set = rejected.get(stationId) ?? new Set<string>();
    set.add(source);
    rejected.set(stationId, set);
  };
  const rejectedSet = (stationId: string) => rejected.get(stationId) ?? new Set<string>();

  const locations = () => {
    const map = new Map<string, { lon: number; lat: number; crs: string }>();
    for (const st of stations) {
      if (st.location) map.set(st.id, st.location);
    }
    return map;
  };

  const ensurePhotonCandidate = async (stationId: string): Promise<void> => {
    const st = byId.get(stationId);
    if (!st) return;
    const list = ctx.candidates.get(stationId) ?? [];
    if (list.some((c) => c.source === 'photon')) return;
    const name = stationName(st);
    if (!name) return;
    for (const city of ctx.cities) {
      const center = cityBbox(city)?.center ?? ctx.cityCenter;
      const hit = await ctx.geocode(name, city, center);
      if (!hit) continue;
      if (!isWithinCityBbox(ctx.city, hit.lon, hit.lat)) continue;
      if (isCoarseCoordinate(hit.lon, hit.lat)) continue;
      const next = [...list, { source: 'photon', location: hit }];
      ctx.candidates.set(stationId, next);
      return;
    }
  };

  const orderedCandidates = (stationId: string) => {
    return [...(ctx.candidates.get(stationId) ?? [])].sort(
      (a, b) => sourcePriority(a.source) - sourcePriority(b.source)
    );
  };

  /** Apply the next unused candidate in cascade order; false when exhausted. */
  const advanceCandidate = async (stationId: string): Promise<boolean> => {
    const st = byId.get(stationId);
    if (!st) return false;
    const banned = rejectedSet(stationId);
    const currentSource = (st.extras?.location_source as string | undefined) ?? undefined;
    const list = orderedCandidates(stationId).filter(
      (c) => c.source !== currentSource && !banned.has(c.source)
    );
    if (list.length > 0) {
      ctx.setLocation(st, list[0].location, list[0].source);
      return true;
    }
    await ensurePhotonCandidate(stationId);
    const photon = (ctx.candidates.get(stationId) ?? []).find(
      (c) => c.source === 'photon' && c.source !== currentSource && !banned.has(c.source)
    );
    if (photon) {
      ctx.setLocation(st, photon.location, photon.source);
      return true;
    }
    return false;
  };

  const evalStation = (stationId: string) =>
    evaluateStationSpeed(stations, ctx.segments, stationId, { lines: ctx.lines });

  // Initial evaluation of every station that participates in timed adjacency.
  let reports = new Map<string, StationSpeedReport>();
  const refreshReports = () => {
    const locs = locations();
    const next = new Map<string, StationSpeedReport>();
    for (const seg of ctx.segments) {
      for (const id of [seg.from_station_id, seg.to_station_id]) {
        if (next.has(id)) continue;
        next.set(id, evalStation(id));
      }
    }
    void locs;
    reports = next;
  };
  refreshReports();

  const failing = () =>
    [...reports.values()]
      .filter((r) => !r.ok)
      .sort((a, b) => {
        // Worst leave-one-out ratio first — the most implausible coords.
        const ar = Math.min(...a.violations.map((v) => v.ratio), Number.POSITIVE_INFINITY);
        const br = Math.min(...b.violations.map((v) => v.ratio), Number.POSITIVE_INFINITY);
        if (ar !== br) return ar - br;
        return (
          Math.max(...b.violations.map((v) => v.ratio), 0) -
          Math.max(...a.violations.map((v) => v.ratio), 0)
        );
      });

  const maxPasses = stations.length * CASCADE_SOURCE_ORDER.length + 8;
  for (let pass = 0; pass < maxPasses; pass++) {
    refreshReports();
    for (const report of reports.values()) ctx.onSpeedValidate?.(report);

    const bad = failing();
    if (bad.length === 0) return;

    const worst = bad[0];
    const st = byId.get(worst.station_id);
    if (!st) return;
    const currentSource = (st.extras?.location_source as string | undefined) ?? '';
    // Current candidate failed speed validation — reject it and move on.
    if (currentSource) reject(worst.station_id, currentSource);
    const advanced = await advanceCandidate(worst.station_id);
    if (!advanced) {
      const remaining = bad.filter((r) => {
        const src = (byId.get(r.station_id)?.extras?.location_source as string | undefined) ?? '';
        const banned = rejectedSet(r.station_id);
        return (
          !src || !banned.has(src) || banned.size < (ctx.candidates.get(r.station_id)?.length ?? 0)
        );
      });
      // Try other failing stations before declaring failure.
      let progressed = false;
      for (const r of bad.slice(1)) {
        const src = (byId.get(r.station_id)?.extras?.location_source as string | undefined) ?? '';
        if (src) reject(r.station_id, src);
        if (await advanceCandidate(r.station_id)) {
          progressed = true;
          break;
        }
      }
      if (!progressed) {
        const details = bad.map((r) => formatSpeedReport(r)).join('\n  ');
        const err = new Error(
          `Coordinate speed validation failed — no source candidate passed leave-one-out checks:\n  ${details}`
        );
        if (ctx.failOnInvalid) throw err;
        return;
      }
      void remaining;
    }
  }

  refreshReports();
  const stillBad = failing();
  if (stillBad.length > 0 && ctx.failOnInvalid) {
    const details = stillBad.map((r) => formatSpeedReport(r)).join('\n  ');
    throw new Error(`Coordinate speed validation failed after source fallback:\n  ${details}`);
  }
}

export type {
  KnownLocation,
  LocatableStation,
  TransformStations,
  TransformStationsContext
} from './transform.js';
