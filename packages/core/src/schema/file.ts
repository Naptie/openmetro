import { Schema } from 'effect';
import { Source } from './provenance.js';

type AnySchema = Schema.Schema<any>;

/**
 * Base URL for published JSON Schemas (generated from the Effect schemas by
 * `scripts/export-json-schemas.ts`). City-agnostic — one document-type schema
 * serves every network.
 */
export const JSON_SCHEMA_BASE =
  'https://raw.githubusercontent.com/Naptie/openmetro/main/schemas/v1';

/** `$schema` URL for one canonical document type (`lines`, `fares`, …). */
export function entitySchemaUrl(documentType: string): string {
  return `${JSON_SCHEMA_BASE}/${documentType}.schema.json`;
}

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
    records: Schema.Array(records)
  });

export type DataFileRecords = Schema.Schema.Type<typeof DataFile>['records'];
