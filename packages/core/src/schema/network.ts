import { Schema } from 'effect';
import { City } from './city.js';
import { Crs } from './geometry.js';
import { MultilingualName } from './names.js';

export const DefaultUnits = Schema.Struct({
  distance: Schema.String,
  time: Schema.String,
  speed: Schema.String
});

export type DefaultUnits = Schema.Schema.Type<typeof DefaultUnits>;

/**
 * Routing defaults for a network. These are part of the canonical data (single
 * source of truth) so consumers never have to hardcode a transfer penalty.
 *
 * - `weight` is the default edge weight ("time" is canonical).
 * - `default_transfer_seconds` is applied to a transfer edge whose
 *   `walk_time_seconds` is unknown (sources that do not publish transfer times).
 * - `max_transfer_seconds` bounds a plausible transfer walk; larger values are
 *   treated as suspect and clamped.
 */
export const RoutingDefaults = Schema.Struct({
  weight: Schema.Literal('time', 'distance'),
  default_transfer_seconds: Schema.Number,
  max_transfer_seconds: Schema.optionalWith(Schema.Number, { as: 'Option' })
});

export type RoutingDefaults = Schema.Schema.Type<typeof RoutingDefaults>;

/**
 * Precision of a published metric value.
 *
 * - `official` — operator publishes this exact field (including direct
 *   route-planner fields such as plantrip wait/transfer minutes)
 * - `derived`  — inferred from another official series (last-train diffs,
 *   searchstartend cumulative jumps)
 * - `default`  — network constant; source published nothing
 */
export const ValuePrecision = Schema.Literal('official', 'derived', 'default');

export type ValuePrecision = Schema.Schema.Type<typeof ValuePrecision>;

/** Aggregate quality of one data layer (segment times, transfer times, fares). */
export const LayerStatus = Schema.Literal('complete', 'partial', 'derived', 'unavailable');

export type LayerStatus = Schema.Schema.Type<typeof LayerStatus>;

export const LayerQuality = Schema.Struct({
  precision: ValuePrecision,
  /** Fraction of entities with a non-default value (0–1). */
  coverage: Schema.Number,
  status: LayerStatus,
  counts: Schema.Record({ key: Schema.String, value: Schema.Number })
});

export type LayerQuality = Schema.Schema.Type<typeof LayerQuality>;

/**
 * Computed at write time from canonical records. Do not hand-edit; re-running
 * the adapter overwrites this block.
 *
 * Layers cover every published metric family:
 * topology, coordinates, names, segment_times, segment_distances,
 * transfer_times, timetables, schematic (stops), fares.
 */
export const NetworkQuality = Schema.Struct({
  topology: LayerQuality,
  coordinates: LayerQuality,
  names: LayerQuality,
  segment_times: LayerQuality,
  segment_distances: LayerQuality,
  transfer_times: LayerQuality,
  timetables: LayerQuality,
  schematic: LayerQuality,
  fares: Schema.optionalWith(LayerQuality, { as: 'Option' })
});

export type NetworkQuality = Schema.Schema.Type<typeof NetworkQuality>;

export const Network = Schema.Struct({
  id: Schema.String,
  /** Primary (Chinese) name for consumers that skip localization. */
  name: Schema.String,
  /** Hand-maintained official network names (e.g. 北京地铁 / Beijing Subway). */
  names: MultilingualName,
  city: City,
  country_code: Schema.String,
  currency: Schema.String,
  timezone: Schema.String,
  coordinate_system: Crs,
  default_units: DefaultUnits,
  routing: RoutingDefaults,
  /** Per-layer precision / coverage, derived from canonical records. */
  quality: Schema.optionalWith(NetworkQuality, { as: 'Option' }),
  notes: Schema.optionalWith(Schema.String, { as: 'Option' })
});

export type Network = Schema.Schema.Type<typeof Network>;
