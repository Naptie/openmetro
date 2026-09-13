import { Schema } from 'effect';
import { Source } from './provenance.js';

/**
 * Origin-destination fare matrix for a network.
 *
 * Fares are **symmetric** and stored as a dense matrix indexed by
 * `station_ids`: `fares[i][j]` is the fare from `station_ids[i]` to
 * `station_ids[j]` in `unit` (e.g. `yuan`), or `null` when no fare was
 * published. The diagonal is always `0`.
 *
 * A matrix is far more compact than one record per pair and is the natural
 * shape for indexing. It is generated from the operator's route/fare API by
 * the network's adapter (`syncFares` in `core/fares`), not hand-edited.
 */
export const FareMatrix = Schema.Struct({
  $schema: Schema.String,
  schema_version: Schema.String,
  network_id: Schema.String,
  generated_at: Schema.String,
  source: Schema.Array(Source),
  currency: Schema.String,
  unit: Schema.String,
  /** Station ids in matrix index order. */
  station_ids: Schema.Array(Schema.String),
  /** Symmetric `station_ids.length` x `station_ids.length` matrix. */
  fares: Schema.Array(Schema.Array(Schema.NullOr(Schema.Number)))
});

export type FareMatrix = Schema.Schema.Type<typeof FareMatrix>;
