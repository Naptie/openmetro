import { Schema } from 'effect';
import { GeoPoint, SchematicPoint } from './geometry.js';

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

export const Stop = Schema.Struct({
  id: Schema.String,
  station_id: Schema.String,
  line_id: Schema.String,
  /**
   * Advisory order within the line's source sequence. Branch stops keep their
   * position in the flat source list; the authoritative adjacency and pattern
   * membership are defined by `Pattern` records (`pattern.stop_ids`), not here.
   */
  sequence: Schema.Number,
  is_terminal: Schema.optionalWith(Schema.Boolean, { as: 'Option' }),
  location: Schema.optionalWith(GeoPoint, { as: 'Option' }),
  schematic: Schema.optionalWith(SchematicPoint, { as: 'Option' }),
  source_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Stop = Schema.Schema.Type<typeof Stop>;
