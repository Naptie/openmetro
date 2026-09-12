import { Schema } from "effect";

const Extras = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

/**
 * Direction type for timetable entries. For linear lines, this is "linear"
 * and `destination_stop_id` indicates the terminal. For loop lines, this
 * indicates the direction of travel around the ring.
 */
export const DirectionType = Schema.Literal("linear", "loop_inner", "loop_outer");

export type DirectionType = Schema.Schema.Type<typeof DirectionType>;

/**
 * A first/last train time pair at a station, on a specific line, toward a
 * specific destination. A "direction" is fully described by the terminal stop
 * the service heads to (and, when known, the origin stop it started from) —
 * with branching, a single forward/backward axis is meaningless.
 *
 * For loop lines, `direction_type` indicates inner/outer ring direction, and
 * `destination_stop_id` is optional (the train travels around the loop).
 *
 * `first_train` / `last_train` are time arrays:
 *   - length 1  => the times are the same every day of the week.
 *   - length 7  => per-day times, indexed 0=Monday ... 6=Sunday, used when the
 *                  source indicates weekday-specific (e.g. Fri/Sat extension)
 *                  timings. Each entry is "HH:MM".
 *
 * Times use the **service-day convention**: minutes since the service day's
 * midnight, so an after-midnight train is written `24:xx` / `25:xx` (GTFS
 * style), never `00:xx` / `01:xx`. This is uniform across every network and
 * keeps a late-night last-train chain monotonic. `normalizeTimetableTimes`
 * converts source data that uses the `00:xx` form.
 *
 * Times are departures by default; `is_arrival` flags a terminal arrival-only
 * entry (some sources mark the last station of a service as an arrival).
 */
export const Timetable = Schema.Struct({
  id: Schema.String,
  station_id: Schema.String,
  /** Platform-level stop on `line_id`. Required — every source can resolve station+line. */
  stop_id: Schema.String,
  line_id: Schema.String,
  station_code: Schema.optionalWith(Schema.String, { as: "Option" }),
  source_id: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** Terminal stop this service heads toward (destination). Required for linear, optional for loop. */
  destination_stop_id: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** Origin stop of the service, when the source exposes it. */
  origin_stop_id: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** Route pattern this service runs on. Required — every line has at least a primary pattern. */
  pattern_id: Schema.String,
  /** Direction type: linear (toward terminal) or loop_inner/loop_outer (around ring). */
  direction_type: Schema.optionalWith(DirectionType, { as: "Option" }),
  direction_label: Schema.optionalWith(Schema.String, { as: "Option" }),
  first_train: Schema.Array(Schema.String),
  last_train: Schema.Array(Schema.String),
  first_train_desc: Schema.optionalWith(Schema.String, { as: "Option" }),
  last_train_desc: Schema.optionalWith(Schema.String, { as: "Option" }),
  is_arrival: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  service: Schema.optionalWith(Schema.String, { as: "Option" }),
  valid_from: Schema.optionalWith(Schema.String, { as: "Option" }),
  valid_to: Schema.optionalWith(Schema.String, { as: "Option" }),
  extras: Schema.optionalWith(Extras, { as: "Option" }),
});

export type Timetable = Schema.Schema.Type<typeof Timetable>;
