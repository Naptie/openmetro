import { Schema } from 'effect';
import { SourceIdRef } from './line.js';
import { MultilingualName } from './names.js';

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

/**
 * A route alignment (service pattern) belonging to a line: an ordered list of
 * stops from an origin to a terminal. A line may have several patterns that
 * share a common trunk and diverge at junctions (branches), e.g. Shanghai
 * Line 11's main `嘉定北 -> 迪士尼` alignment and its `花桥 -> 迪士尼` branch.
 *
 * Patterns are the source of truth for topology: segments are the union of
 * consecutive stop pairs across every pattern of a line, so junctions get the
 * correct three-way adjacency instead of a single linear chain.
 */
export const Pattern = Schema.Struct({
  id: Schema.String,
  line_id: Schema.String,
  name: Schema.optionalWith(Schema.String, { as: 'Option' }),
  names: Schema.optionalWith(MultilingualName, { as: 'Option' }),
  /** Ordered stop ids, origin first, terminal last. */
  stop_ids: Schema.Array(Schema.String),
  /** First stop of the alignment (origin). */
  origin_stop_id: Schema.String,
  /** Last stop of the alignment (destination). */
  terminal_stop_id: Schema.String,
  /** True for the line's main alignment; false for branches. */
  is_primary: Schema.Boolean,
  /** For a branch, the stop on the primary alignment where it diverges. */
  junction_stop_id: Schema.optionalWith(Schema.String, { as: 'Option' }),
  color: Schema.optionalWith(Schema.String, { as: 'Option' }),
  source_ids: Schema.Array(SourceIdRef),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Pattern = Schema.Schema.Type<typeof Pattern>;
