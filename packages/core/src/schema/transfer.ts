import { Schema } from 'effect';

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

export const Transfer = Schema.Struct({
  id: Schema.String,
  station_id: Schema.String,
  from_line_id: Schema.String,
  to_line_id: Schema.String,
  from_stop_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  to_stop_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  walk_time_seconds: Schema.optionalWith(Schema.Number, { as: 'Option' }),
  walk_distance_meters: Schema.optionalWith(Schema.Number, { as: 'Option' }),
  is_out_of_station: Schema.optionalWith(Schema.Boolean, { as: 'Option' }),
  source_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Transfer = Schema.Schema.Type<typeof Transfer>;
