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

export const CASCADE_SOURCE_ORDER = [
  'known',
  'subway',
  'source',
  'official',
  'overpass',
  'osm',
  'photon'
] as const;

/**
 * Fallback level for a failing station during speed validation.
 * 0 = keep the cascade assignment; 1 = overpass; 2 = photon.
 */
export type FallbackLevel = 0 | 1 | 2;

const OVERPASS_SOURCES = new Set(['overpass', 'osm']);

/** All k-subsets of `items`, in stable lexicographic order of indices. */
function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  if (k < 0 || k > items.length) return;
  if (k === 0) {
    yield [];
    return;
  }
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === items.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
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
      ctx.candidates.set(stationId, [...list, { source: 'photon', location: hit }]);
      return;
    }
  };

  const overpassCandidate = (stationId: string) =>
    ctx.candidates.get(stationId)?.find((c) => OVERPASS_SOURCES.has(c.source));

  const photonCandidate = (stationId: string) =>
    ctx.candidates.get(stationId)?.find((c) => c.source === 'photon');

  type Snapshot = {
    id: string;
    location?: { lon: number; lat: number; crs: string };
    extras?: Record<string, unknown>;
  };
  const snapshotAll = (): Snapshot[] =>
    stations.map((s) => ({
      id: s.id,
      location: s.location ? { ...s.location } : undefined,
      extras: s.extras ? { ...s.extras } : undefined
    }));
  const restoreAll = (snap: Snapshot[]) => {
    for (const row of snap) {
      const st = byId.get(row.id);
      if (!st) continue;
      st.location = row.location ? { ...row.location } : undefined;
      st.extras = row.extras ? { ...row.extras } : undefined;
    }
  };

  const stationIdsWithSegments = new Set<string>();
  for (const seg of ctx.segments) {
    stationIdsWithSegments.add(seg.from_station_id);
    stationIdsWithSegments.add(seg.to_station_id);
  }

  const evalAll = (): StationSpeedReport[] =>
    [...stationIdsWithSegments].map((id) =>
      evaluateStationSpeed(stations, ctx.segments, id, { lines: ctx.lines })
    );

  const reports = evalAll();
  for (const r of reports) ctx.onSpeedValidate?.(r);

  const failing = reports
    .filter((r) => !r.ok)
    .map((r) => r.station_id)
    .sort();
  if (failing.length === 0) return;

  const formatFailures = (rs: StationSpeedReport[]) =>
    rs
      .filter((r) => !r.ok)
      .map((r) => formatSpeedReport(r))
      .join('\n  ');

  /** Resolve coords for (station, level); undefined when that level is unavailable. */
  const resolveLevel = async (
    stationId: string,
    level: FallbackLevel
  ): Promise<{ source: string; location: GeoResult } | undefined> => {
    if (level === 0) {
      const st = byId.get(stationId);
      if (!st?.location) return undefined;
      return {
        source: String((st.extras?.location_source as string | undefined) ?? 'source'),
        location: { lon: st.location.lon, lat: st.location.lat, crs: 'gcj02' }
      };
    }
    if (level === 1) {
      const c = overpassCandidate(stationId);
      return c ? { source: 'overpass', location: c.location } : undefined;
    }
    await ensurePhotonCandidate(stationId);
    const c = photonCandidate(stationId);
    return c ? { source: 'photon', location: c.location } : undefined;
  };

  /**
   * Apply levels to the failing set (0 = leave as-is), re-check the whole
   * network, restore on failure. Returns true when every station passes.
   */
  const tryAssignment = async (assign: Map<string, FallbackLevel>): Promise<boolean> => {
    const snap = snapshotAll();
    for (const [id, level] of assign) {
      if (level === 0) continue;
      const cand = await resolveLevel(id, level);
      if (!cand) {
        restoreAll(snap);
        return false;
      }
      ctx.setLocation(byId.get(id) as T, cand.location, cand.source);
    }
    const next = evalAll();
    const bad = next.filter((r) => !r.ok);
    if (bad.length === 0) {
      for (const r of next) ctx.onSpeedValidate?.(r);
      return true;
    }
    restoreAll(snap);
    return false;
  };

  const baseAssign = (): Map<string, FallbackLevel> => {
    const m = new Map<string, FallbackLevel>();
    for (const id of failing) m.set(id, 0);
    return m;
  };

  const n = failing.length;
  const maxEvaluations = 4096;
  let evaluations = 0;

  const evaluateAssign = async (assign: Map<string, FallbackLevel>): Promise<boolean> => {
    evaluations++;
    if (evaluations > maxEvaluations) {
      throw new Error(
        `Coordinate speed validation exceeded ${maxEvaluations} fallback combinations (${n} failing stations)`
      );
    }
    return tryAssignment(assign);
  };

  // Phase 1: only k=1 on a growing subset of failing stations; others stay k=0.
  for (let m = 1; m <= n; m++) {
    for (const subset of combinations(failing, m)) {
      const assign = baseAssign();
      for (const id of subset) assign.set(id, 1);
      if (await evaluateAssign(assign)) return;
    }
  }

  // Phase 2: introduce k=2 stations; remaining stations enumerate k∈{0,1}
  // in the same "more k=1 first-subsets later" order as phase 1.
  for (let m2 = 1; m2 <= n; m2++) {
    for (const twoSet of combinations(failing, m2)) {
      const rest = failing.filter((id) => !twoSet.includes(id));
      for (let m1 = 0; m1 <= rest.length; m1++) {
        for (const oneSet of combinations(rest, m1)) {
          const assign = baseAssign();
          for (const id of oneSet) assign.set(id, 1);
          for (const id of twoSet) assign.set(id, 2);
          if (await evaluateAssign(assign)) return;
        }
      }
    }
  }

  const finalReports = evalAll();
  const stillBad = finalReports.filter((r) => !r.ok);
  if (stillBad.length > 0 && ctx.failOnInvalid) {
    throw new Error(
      `Coordinate speed validation failed — no fallback assignment (k∈{0,1,2}) passed:\n  ${formatFailures(finalReports)}`
    );
  }
}

export type {
  KnownLocation,
  LocatableStation,
  TransformStations,
  TransformStationsContext
} from './transform.js';
