import { Schema } from "effect";
import { Source } from "./provenance.js";

type AnySchema = Schema.Schema<any>;

/**
 * Generic wrapper object that every canonical data file conforms to.
 * `records` is typed by the specific entity schema at call sites.
 */
export const DataFile = (records: AnySchema) =>
  Schema.Struct({
    $schema: Schema.String,
    schema_version: Schema.String,
    network_id: Schema.String,
    generated_at: Schema.String,
    source: Schema.Array(Source),
    records: Schema.Array(records),
  });

export type DataFileRecords = Schema.Schema.Type<typeof DataFile>["records"];
