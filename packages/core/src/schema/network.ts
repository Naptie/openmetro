import { Schema } from 'effect';
import { City } from './city.js';
import { Crs } from './geometry.js';
import { MultilingualName } from './names.js';
import { Source } from './provenance.js';

export const DefaultUnits = Schema.Struct({
  distance: Schema.String,
  time: Schema.String,
  speed: Schema.String
});

export type DefaultUnits = Schema.Schema.Type<typeof DefaultUnits>;

export const Operator = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  website: Schema.optionalWith(Schema.String, { as: 'Option' })
});

export type Operator = Schema.Schema.Type<typeof Operator>;

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
  operators: Schema.Array(Operator),
  source: Schema.Array(Source),
  notes: Schema.optionalWith(Schema.String, { as: 'Option' })
});

export type Network = Schema.Schema.Type<typeof Network>;
