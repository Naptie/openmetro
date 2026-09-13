import { Schema } from 'effect';
import { GeoPoint, SchematicPoint } from './geometry.js';
import { SourceIdRef } from './line.js';
import { MultilingualName } from './names.js';

/**
 * `out_of_service` is used when the source publishes first/last trains for
 * other stations on the same line but none for this station — we cannot tell
 * planned vs under_construction vs temporarily closed, only that it is not
 * in published passenger service.
 */
export const StationStatus = Schema.Literal(
  'operating',
  'out_of_service',
  'closed',
  'under_construction',
  'planned'
);

export type StationStatus = Schema.Schema.Type<typeof StationStatus>;

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

export const Station = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  names: MultilingualName,
  location: Schema.optionalWith(GeoPoint, { as: 'Option' }),
  schematic: Schema.optionalWith(SchematicPoint, { as: 'Option' }),
  status: StationStatus,
  source_ids: Schema.Array(SourceIdRef),
  identity_notes: Schema.optionalWith(Schema.String, { as: 'Option' }),
  valid_from: Schema.optionalWith(Schema.String, { as: 'Option' }),
  valid_to: Schema.optionalWith(Schema.String, { as: 'Option' }),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Station = Schema.Schema.Type<typeof Station>;
