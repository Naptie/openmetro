import { Schema } from 'effect';
import { GeoPoint, SchematicPoint } from './geometry.js';
import { SourceIdRef } from './line.js';
import { MultilingualName } from './names.js';

/**
 * Canonical station service status.
 *
 * - `operating` — in published passenger service.
 * - `out_of_service` — present on the official map/line but not in published
 *   passenger service (timetable omits this station while the line publishes
 *   times for others; source forced offline; permanently closed stop).
 * - `under_construction` — planned or under construction, not yet open.
 *
 * Routing treats only `operating` stations as boardable/alightable by default.
 */
export const StationStatus = Schema.Literal('operating', 'out_of_service', 'under_construction');

export type StationStatus = Schema.Schema.Type<typeof StationStatus>;

const STATION_STATUS_VALUES = new Set<string>([
  'operating',
  'out_of_service',
  'under_construction'
]);

/** True when a station may appear as an origin/destination or transfer node. */
export function isStationRoutable(status: StationStatus | undefined): boolean {
  return status == null || status === 'operating';
}

/**
 * Map arbitrary source status strings onto the canonical three-value enum.
 * Legacy/loose feed values collapse deterministically:
 * `planned` → `under_construction`, `closed` → `out_of_service`.
 */
export function coerceStationStatus(raw: string | undefined | null): StationStatus {
  if (raw && STATION_STATUS_VALUES.has(raw)) return raw as StationStatus;
  if (raw === 'planned' || raw === 'under construction') return 'under_construction';
  if (raw === 'closed' || raw === 'out of service') return 'out_of_service';
  return 'operating';
}

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
