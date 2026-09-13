import { Schema } from 'effect';
import { MultilingualName } from './names.js';

/**
 * City metadata sourced from worldwide-regions.  The `id` is the region ID
 * from the dataset (e.g. CN-11, CN-31, CN-4401).  `name`, `population`,
 * `area` and `location` are taken verbatim from the region record.  `country`
 * is derived from the top-level ancestor.
 */
export const City = Schema.Struct({
  id: Schema.String,
  name: MultilingualName,
  country: Schema.String,
  population: Schema.NullOr(Schema.Number),
  area: Schema.NullOr(Schema.Number),
  location: Schema.NullOr(
    Schema.Struct({
      type: Schema.Literal('Point'),
      coordinates: Schema.Tuple(Schema.Number, Schema.Number)
    })
  )
});

export type City = Schema.Schema.Type<typeof City>;
