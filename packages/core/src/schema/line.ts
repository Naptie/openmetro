import { Schema } from 'effect';
import { GeoPoint, SchematicPoint } from './geometry.js';
import { MultilingualName } from './names.js';

export const LineMode = Schema.Literal(
  'metro',
  'suburban_rail',
  'light_rail',
  'tram',
  'monorail',
  'airport_express',
  'other'
);

export type LineMode = Schema.Schema.Type<typeof LineMode>;

/**
 * Canonical line service status.
 *
 * - `operating` — line is in passenger service (fully or essentially).
 * - `under_construction` — planned / under construction / not yet open.
 */
export const LineStatus = Schema.Literal('operating', 'under_construction');

export type LineStatus = Schema.Schema.Type<typeof LineStatus>;

const LINE_STATUS_VALUES = new Set<string>(['operating', 'under_construction']);

/** True when a line is in published passenger service. */
export function isLineOperating(status: LineStatus | undefined): boolean {
  return status == null || status === 'operating';
}

/**
 * Map loose source status strings onto the two-value enum.
 * `planned` / `closed` / `under construction` → `under_construction`.
 * `partially_operating` still has passenger service → `operating`.
 */
export function coerceLineStatus(raw: string | undefined | null): LineStatus {
  if (raw && LINE_STATUS_VALUES.has(raw)) return raw as LineStatus;
  if (raw === 'partially_operating') return 'operating';
  if (raw === 'planned' || raw === 'closed' || raw === 'under construction') {
    return 'under_construction';
  }
  return 'operating';
}

/** A source reference: which source file/record produced this entity. */
export const SourceIdRef = Schema.Struct({
  source: Schema.String,
  id: Schema.String
});

export type SourceIdRef = Schema.Schema.Type<typeof SourceIdRef>;

/** Ordered polyline with a single datum. */
export const Geometry = Schema.Struct({
  crs: Schema.Literal('wgs84', 'gcj02', 'bd09', 'schematic'),
  points: Schema.Array(Schema.Union(GeoPoint, SchematicPoint))
});

export type Geometry = Schema.Schema.Type<typeof Geometry>;

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

export const Line = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  names: MultilingualName,
  aliases: Schema.Array(Schema.String),
  color: Schema.optionalWith(Schema.String, { as: 'Option' }),
  text_color: Schema.optionalWith(Schema.String, { as: 'Option' }),
  short_name: Schema.String,
  mode: LineMode,
  status: LineStatus,
  loop: Schema.Boolean,
  source_ids: Schema.Array(SourceIdRef),
  geometry: Schema.optionalWith(Geometry, { as: 'Option' }),
  valid_from: Schema.optionalWith(Schema.String, { as: 'Option' }),
  valid_to: Schema.optionalWith(Schema.String, { as: 'Option' }),
  extras: Schema.optionalWith(Extras, { as: 'Option' })
});

export type Line = Schema.Schema.Type<typeof Line>;
