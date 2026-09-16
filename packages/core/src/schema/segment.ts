import { Schema } from 'effect';
import { Geometry } from './line.js';

export const SegmentDirection = Schema.Literal('both', 'forward', 'backward');

export type SegmentDirection = Schema.Schema.Type<typeof SegmentDirection>;

/** How a segment's travel time was obtained. */
export const TravelTimeSource = Schema.Literal('source', 'planner', 'last_train', 'estimated');

export type TravelTimeSource = Schema.Schema.Type<typeof TravelTimeSource>;

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

export const Segment = Schema.Struct({
  id: Schema.String,
  line_id: Schema.String,
  from_stop_id: Schema.String,
  to_stop_id: Schema.String,
  /**
   * Denormalized station endpoints (derived from `stops`). The stop-to-station
   * mapping in `stops.json` remains the single source of truth; these are
   * provided so edge tables can be consumed without an extra join.
   */
  from_station_id: Schema.String,
  to_station_id: Schema.String,
  direction: SegmentDirection,
  travel_time_seconds: Schema.optionalWith(Schema.Number, { as: 'Option' }),
  travel_time_source: Schema.optionalWith(TravelTimeSource, { as: 'Option' }),
  travel_time_derived_from: Schema.optionalWith(Schema.Array(Schema.String), {
    as: 'Option'
  }),
  distance_km: Schema.optionalWith(Schema.Number, { as: 'Option' }),
  geometry: Schema.optionalWith(Geometry, { as: 'Option' }),
  source_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Segment = Schema.Schema.Type<typeof Segment>;
