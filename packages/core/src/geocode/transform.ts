/**
 * Adapter transform hook + known-location contract.
 *
 * `transformStations` is the per-adapter hook for city-specific station
 * corrections. Adapters implement it with the same signature and call it after
 * `fillCoordinates` so it is the final word on station fields exceptional to a
 * city. Coordinate overrides that should win over any geocoder are declared as
 * `KnownLocation`s and fed into `fillCoordinates` via its `knownLocations`
 * option, so the correct coordinate and its provenance are recorded.
 */

/**
 * A hand-verified station coordinate that overrides any geocoder result.
 * These are treated as the highest-priority source in `fillCoordinates`
 * (above AMap subway), so the correct coordinate is selected and its
 * provenance is recorded in `extras.location_source`.
 */
export interface KnownLocation {
  /** Chinese name after rare-character folding. */
  name: string;
  location: { lon: number; lat: number; crs: 'gcj02' };
  /** Provenance label recorded in `extras.location_source`, e.g. 'osm'. */
  source: string;
}

/** Minimal station shape the transform hook operates on. */
export interface LocatableStation {
  id: string;
  name?: string;
  names?: { zh?: string };
  location?: { lon: number; lat: number; crs: string };
  extras?: Record<string, unknown>;
}

export interface TransformStationsContext {
  /** Canonical network id, e.g. 'cn-guangzhou'. */
  network: string;
  /** Primary city name. */
  city: string;
  /** Extra cities passed to geocoding. */
  extraCities?: string[];
}

/**
 * Adapter hook for city-specific station corrections, applied after
 * `fillCoordinates` and before writing canonical output. Adapters use it to
 * swap incorrect coordinates, re-assert known locations, or adjust fields.
 *
 * Coordinate overrides that should be treated as authoritative geocoder
 * candidates are declared as `KnownLocation`s in the same module and passed
 * to `fillCoordinates` via its `knownLocations` option — that is how this
 * hook integrates with the fill-coords pipeline rather than fighting it.
 */
export type TransformStations = <T extends LocatableStation>(
  stations: T[],
  ctx: TransformStationsContext
) => T[];
