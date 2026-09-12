/**
 * Cross-source coordinate resolution with consistency checks.
 *
 * Trust order:
 *   1. AMap subway — p50 vs official 36 m; most complete for metro
 *   2. Official operator API — often right, sometimes same-name POI miss
 *      (香雪公园→Shanghai, 花围→Heyuan)
 *   3. Overpass — complete but occasional same-name miss
 *   4. Photon — free forward geocode, city-biased
 *
 * Every candidate must sit inside the city bbox and, when ≥2 same-line
 * peers already have coordinates, within `MAX_NEAREST_KM` of the nearest
 * peer. That single rule removes the need for a separate post-hoc outlier pass.
 */

/** A placed coordinate; only `lon`/`lat` participate in consistency checks. */
type Coordinate = { lon: number; lat: number; crs: string };

// ── Haversine ───────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Calibrated: metro p99 nearest-neighbour ≈ 8 km; true outliers are 40 km+. */
export const MAX_NEAREST_KM: Record<string, number> = {
  metro: 15,
  light_rail: 15,
  monorail: 15,
  tram: 10,
  airport_express: 45,
  suburban_rail: 20,
  other: 20,
};

export function maxNearestKm(mode: string | undefined): number {
  return MAX_NEAREST_KM[mode ?? "other"] ?? 20;
}

/**
 * Official APIs sometimes return city-grid precision (exactly 2 decimal
 * places, ~1 km). Too coarse for a station — treat as missing.
 */
export function isCoarseCoordinate(lon: number, lat: number): boolean {
  const onGrid = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
  return onGrid(lon) && onGrid(lat);
}

/**
 * Distance to the nearest already-placed station on any shared line.
 * `undefined` when fewer than `minPeers` peers are placed (cannot judge).
 */
export function nearestSameLinePeerKm(
  stationId: string,
  loc: Coordinate,
  placed: Map<string, Coordinate>,
  stopsByStation: Map<string, string[]>,
  stopsByLine: Map<string, string[]>,
  minPeers = 2,
): number | undefined {
  const lineIds = stopsByStation.get(stationId) ?? [];
  const distances: number[] = [];
  for (const lineId of lineIds) {
    for (const peerId of stopsByLine.get(lineId) ?? []) {
      if (peerId === stationId) continue;
      const peerLoc = placed.get(peerId);
      if (!peerLoc) continue;
      distances.push(haversineKm(loc, peerLoc));
    }
  }
  if (distances.length < minPeers) return undefined;
  return Math.min(...distances);
}

/** True when the candidate agrees with the same-line cluster (or we have no peers). */
export function isConsistentWithLine(
  stationId: string,
  loc: Coordinate,
  placed: Map<string, Coordinate>,
  stopsByStation: Map<string, string[]>,
  stopsByLine: Map<string, string[]>,
  modeByLine: Map<string, string>,
  lineIdsOf: string[],
): boolean {
  const nearest = nearestSameLinePeerKm(stationId, loc, placed, stopsByStation, stopsByLine);
  if (nearest == null) return true;
  // Use the strictest mode among the station's lines.
  const limit = Math.min(...lineIdsOf.map((l) => maxNearestKm(modeByLine.get(l))));
  return nearest <= limit;
}
