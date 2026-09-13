import { Schema } from 'effect';

/** License values for a data source. */
export const License = Schema.Literal('unknown', 'cc0', 'cc-by', 'cc-by-sa', 'odbl', 'custom');

export type License = Schema.Schema.Type<typeof License>;

/**
 * Provenance metadata required on every data file. Records reference back to
 * a source via `source_ids`.
 */
export const Source = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  version: Schema.String,
  retrieved_at: Schema.String,
  license: License,
  license_url: Schema.NullOr(Schema.String),
  attribution: Schema.String,
  notes: Schema.optionalWith(Schema.String, { as: 'Option' })
});

export type Source = Schema.Schema.Type<typeof Source>;
