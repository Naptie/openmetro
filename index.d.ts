import { Treaty } from '@elysia/eden';
import * as _sinclair_typebox from '@sinclair/typebox';
import { Elysia } from 'elysia';
import { Schema, Effect } from 'effect';

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
declare const FareMatrix: Schema.Struct<{
    $schema: typeof Schema.String;
    schema_version: typeof Schema.String;
    network_id: typeof Schema.String;
    generated_at: typeof Schema.String;
    source: Schema.Array$<Schema.Struct<{
        name: typeof Schema.String;
        url: typeof Schema.String;
        version: typeof Schema.String;
        retrieved_at: typeof Schema.String;
        license: Schema.Literal<["unknown", "cc0", "cc-by", "cc-by-sa", "odbl", "custom"]>;
        license_url: Schema.NullOr<typeof Schema.String>;
        attribution: typeof Schema.String;
        notes: Schema.optionalWith<typeof Schema.String, {
            as: "Option";
        }>;
    }>>;
    currency: typeof Schema.String;
    unit: typeof Schema.String;
    /** Station ids in matrix index order. */
    station_ids: Schema.Array$<typeof Schema.String>;
    /** Symmetric `station_ids.length` x `station_ids.length` matrix. */
    fares: Schema.Array$<Schema.Array$<Schema.NullOr<typeof Schema.Number>>>;
}>;
type FareMatrix = Schema.Schema.Type<typeof FareMatrix>;

declare const Line: Schema.Struct<{
    id: typeof Schema.String;
    name: typeof Schema.String;
    names: Schema.Struct<{
        zh: typeof Schema.String;
        en: typeof Schema.String;
    }>;
    aliases: Schema.Array$<typeof Schema.String>;
    color: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    text_color: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    short_name: typeof Schema.String;
    mode: Schema.Literal<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
    status: Schema.Literal<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
    loop: typeof Schema.Boolean;
    source_ids: Schema.Array$<Schema.Struct<{
        source: typeof Schema.String;
        id: typeof Schema.String;
    }>>;
    geometry: Schema.optionalWith<Schema.Struct<{
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic"]>;
        points: Schema.Array$<Schema.Union<[Schema.Struct<{
            lon: typeof Schema.Number;
            lat: typeof Schema.Number;
            crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }>, Schema.Struct<{
            x: typeof Schema.Number;
            y: typeof Schema.Number;
            crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }>]>>;
    }>, {
        as: "Option";
    }>;
    valid_from: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    valid_to: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Line = Schema.Schema.Type<typeof Line>;

declare const Network: Schema.Struct<{
    id: typeof Schema.String;
    /** Primary (Chinese) name for consumers that skip localization. */
    name: typeof Schema.String;
    /** Hand-maintained official network names (e.g. 北京地铁 / Beijing Subway). */
    names: Schema.Struct<{
        zh: typeof Schema.String;
        en: typeof Schema.String;
    }>;
    city: Schema.Struct<{
        id: typeof Schema.String;
        name: Schema.Struct<{
            zh: typeof Schema.String;
            en: typeof Schema.String;
        }>;
        country: typeof Schema.String;
        population: Schema.NullOr<typeof Schema.Number>;
        area: Schema.NullOr<typeof Schema.Number>;
        location: Schema.NullOr<Schema.Struct<{
            type: Schema.Literal<["Point"]>;
            coordinates: Schema.Tuple2<typeof Schema.Number, typeof Schema.Number>;
        }>>;
    }>;
    country_code: typeof Schema.String;
    currency: typeof Schema.String;
    timezone: typeof Schema.String;
    coordinate_system: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    default_units: Schema.Struct<{
        distance: typeof Schema.String;
        time: typeof Schema.String;
        speed: typeof Schema.String;
    }>;
    routing: Schema.Struct<{
        weight: Schema.Literal<["time", "distance"]>;
        default_transfer_seconds: typeof Schema.Number;
        max_transfer_seconds: Schema.optionalWith<typeof Schema.Number, {
            as: "Option";
        }>;
    }>;
    operators: Schema.Array$<Schema.Struct<{
        id: typeof Schema.String;
        name: typeof Schema.String;
        website: Schema.optionalWith<typeof Schema.String, {
            as: "Option";
        }>;
    }>>;
    source: Schema.Array$<Schema.Struct<{
        name: typeof Schema.String;
        url: typeof Schema.String;
        version: typeof Schema.String;
        retrieved_at: typeof Schema.String;
        license: Schema.Literal<["unknown", "cc0", "cc-by", "cc-by-sa", "odbl", "custom"]>;
        license_url: Schema.NullOr<typeof Schema.String>;
        attribution: typeof Schema.String;
        notes: Schema.optionalWith<typeof Schema.String, {
            as: "Option";
        }>;
    }>>;
    notes: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
}>;
type Network = Schema.Schema.Type<typeof Network>;

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
declare const Pattern: Schema.Struct<{
    id: typeof Schema.String;
    line_id: typeof Schema.String;
    name: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    names: Schema.optionalWith<Schema.Struct<{
        zh: typeof Schema.String;
        en: typeof Schema.String;
    }>, {
        as: "Option";
    }>;
    /** Ordered stop ids, origin first, terminal last. */
    stop_ids: Schema.Array$<typeof Schema.String>;
    /** First stop of the alignment (origin). */
    origin_stop_id: typeof Schema.String;
    /** Last stop of the alignment (destination). */
    terminal_stop_id: typeof Schema.String;
    /** True for the line's main alignment; false for branches. */
    is_primary: typeof Schema.Boolean;
    /** For a branch, the stop on the primary alignment where it diverges. */
    junction_stop_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    color: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    source_ids: Schema.Array$<Schema.Struct<{
        source: typeof Schema.String;
        id: typeof Schema.String;
    }>>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Pattern = Schema.Schema.Type<typeof Pattern>;

declare const Segment: Schema.Struct<{
    id: typeof Schema.String;
    line_id: typeof Schema.String;
    from_stop_id: typeof Schema.String;
    to_stop_id: typeof Schema.String;
    /**
     * Denormalized station endpoints (derived from `stops`). The stop-to-station
     * mapping in `stops.json` remains the single source of truth; these are
     * provided so edge tables can be consumed without an extra join.
     */
    from_station_id: typeof Schema.String;
    to_station_id: typeof Schema.String;
    direction: Schema.Literal<["both", "forward", "backward"]>;
    travel_time_seconds: Schema.optionalWith<typeof Schema.Number, {
        as: "Option";
    }>;
    travel_time_source: Schema.optionalWith<Schema.Literal<["source", "last_train", "estimated"]>, {
        as: "Option";
    }>;
    travel_time_derived_from: Schema.optionalWith<Schema.Array$<typeof Schema.String>, {
        as: "Option";
    }>;
    distance_km: Schema.optionalWith<typeof Schema.Number, {
        as: "Option";
    }>;
    geometry: Schema.optionalWith<Schema.Struct<{
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic"]>;
        points: Schema.Array$<Schema.Union<[Schema.Struct<{
            lon: typeof Schema.Number;
            lat: typeof Schema.Number;
            crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }>, Schema.Struct<{
            x: typeof Schema.Number;
            y: typeof Schema.Number;
            crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }>]>>;
    }>, {
        as: "Option";
    }>;
    source_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Segment = Schema.Schema.Type<typeof Segment>;

declare const Station: Schema.Struct<{
    id: typeof Schema.String;
    name: typeof Schema.String;
    names: Schema.Struct<{
        zh: typeof Schema.String;
        en: typeof Schema.String;
    }>;
    location: Schema.optionalWith<Schema.Struct<{
        lon: typeof Schema.Number;
        lat: typeof Schema.Number;
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }>, {
        as: "Option";
    }>;
    schematic: Schema.optionalWith<Schema.Struct<{
        x: typeof Schema.Number;
        y: typeof Schema.Number;
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }>, {
        as: "Option";
    }>;
    status: Schema.Literal<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
    source_ids: Schema.Array$<Schema.Struct<{
        source: typeof Schema.String;
        id: typeof Schema.String;
    }>>;
    identity_notes: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    valid_from: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    valid_to: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Station = Schema.Schema.Type<typeof Station>;

declare const Stop: Schema.Struct<{
    id: typeof Schema.String;
    station_id: typeof Schema.String;
    line_id: typeof Schema.String;
    /**
     * Advisory order within the line's source sequence. Branch stops keep their
     * position in the flat source list; the authoritative adjacency and pattern
     * membership are defined by `Pattern` records (`pattern.stop_ids`), not here.
     */
    sequence: typeof Schema.Number;
    is_terminal: Schema.optionalWith<typeof Schema.Boolean, {
        as: "Option";
    }>;
    location: Schema.optionalWith<Schema.Struct<{
        lon: typeof Schema.Number;
        lat: typeof Schema.Number;
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }>, {
        as: "Option";
    }>;
    schematic: Schema.optionalWith<Schema.Struct<{
        x: typeof Schema.Number;
        y: typeof Schema.Number;
        crs: Schema.Literal<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }>, {
        as: "Option";
    }>;
    source_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Stop = Schema.Schema.Type<typeof Stop>;

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
declare const Timetable: Schema.Struct<{
    id: typeof Schema.String;
    station_id: typeof Schema.String;
    /** Platform-level stop on `line_id`. Required — every source can resolve station+line. */
    stop_id: typeof Schema.String;
    line_id: typeof Schema.String;
    station_code: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    source_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    /** Terminal stop this service heads toward (destination). Required for linear, optional for loop. */
    destination_stop_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    /** Origin stop of the service, when the source exposes it. */
    origin_stop_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    /** Route pattern this service runs on. Required — every line has at least a primary pattern. */
    pattern_id: typeof Schema.String;
    /** Direction type: linear (toward terminal) or loop_inner/loop_outer (around ring). */
    direction_type: Schema.optionalWith<Schema.Literal<["linear", "loop_inner", "loop_outer"]>, {
        as: "Option";
    }>;
    direction_label: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    first_train: Schema.Array$<typeof Schema.String>;
    last_train: Schema.Array$<typeof Schema.String>;
    first_train_desc: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    last_train_desc: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    is_arrival: Schema.optionalWith<typeof Schema.Boolean, {
        as: "Option";
    }>;
    service: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    valid_from: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    valid_to: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Timetable = Schema.Schema.Type<typeof Timetable>;

declare const Transfer: Schema.Struct<{
    id: typeof Schema.String;
    station_id: typeof Schema.String;
    from_line_id: typeof Schema.String;
    to_line_id: typeof Schema.String;
    from_stop_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    to_stop_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    walk_time_seconds: Schema.optionalWith<typeof Schema.Number, {
        as: "Option";
    }>;
    walk_distance_meters: Schema.optionalWith<typeof Schema.Number, {
        as: "Option";
    }>;
    is_out_of_station: Schema.optionalWith<typeof Schema.Boolean, {
        as: "Option";
    }>;
    source_id: Schema.optionalWith<typeof Schema.String, {
        as: "Option";
    }>;
    extras: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>, {
        as: "Option";
    }>;
}>;
type Transfer = Schema.Schema.Type<typeof Transfer>;

type LineEncoded = Schema.Schema.Encoded<typeof Line>;
type StationEncoded = Schema.Schema.Encoded<typeof Station>;
type StopEncoded = Schema.Schema.Encoded<typeof Stop>;
type PatternEncoded = Schema.Schema.Encoded<typeof Pattern>;
type SegmentEncoded = Schema.Schema.Encoded<typeof Segment>;
type FareMatrixEncoded = Schema.Schema.Encoded<typeof FareMatrix>;
type TransferEncoded = Schema.Schema.Encoded<typeof Transfer>;
type TimetableEncoded = Schema.Schema.Encoded<typeof Timetable>;
type NetworkEncoded = Schema.Schema.Encoded<typeof Network>;

/** Fully decoded canonical data for one network. */
interface NetworkData {
    network: NetworkEncoded;
    lines: LineEncoded[];
    stations: StationEncoded[];
    stops: StopEncoded[];
    patterns: PatternEncoded[];
    segments: SegmentEncoded[];
    transfers: TransferEncoded[];
    timetables: TimetableEncoded[];
    /** Origin-destination fare matrix; absent when the network has no fares. */
    fares: FareMatrixEncoded | undefined;
    /** Latest `generated_at` stamp among the network's canonical files. */
    generated_at: string;
}

/**
 * A pluggable source of canonical network data. The filesystem implementation
 * is used by the Node/Bun API and CLI; a memory implementation is used by the
 * Cloudflare Worker (which has no filesystem).
 */
interface NetworkSource {
    /** List available network ids. */
    list(): Promise<string[]>;
    /** Load and validate one network's full data. */
    load(id: string): Effect.Effect<NetworkData, unknown>;
    /** Load and validate one network's metadata only. */
    loadMeta(id: string): Effect.Effect<NetworkEncoded, unknown>;
}

interface ApiAppOptions {
    /**
     * Elysia's ahead-of-time compiler uses `new Function`, which runtimes such as
     * Cloudflare Workers forbid. Set `false` there to use the interpreted handler.
     */
    aot?: boolean;
}
/**
 * Build the Elysia API app over an abstract `NetworkSource`.
 *
 * This module is runtime-agnostic (no `node:fs`): the Node/Bun server injects a
 * filesystem source and the Cloudflare Worker injects a bundled memory source.
 * OpenAPI docs are served at `/swagger` (JSON at `/swagger/json`).
 */
declare function createApiApp(source: NetworkSource, options?: ApiAppOptions): Elysia<"", {
    decorator: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    typebox: {
        readonly ApiCrs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
        readonly ApiNames: _sinclair_typebox.TObject<{
            zh: _sinclair_typebox.TString;
            en: _sinclair_typebox.TString;
        }>;
        readonly ApiGeoPoint: _sinclair_typebox.TObject<{
            lon: _sinclair_typebox.TNumber;
            lat: _sinclair_typebox.TNumber;
            crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
        }>;
        readonly ApiSchematicPoint: _sinclair_typebox.TObject<{
            x: _sinclair_typebox.TNumber;
            y: _sinclair_typebox.TNumber;
            crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
        }>;
        readonly ApiLineMode: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"metro">, _sinclair_typebox.TLiteral<"suburban_rail">, _sinclair_typebox.TLiteral<"light_rail">, _sinclair_typebox.TLiteral<"tram">, _sinclair_typebox.TLiteral<"monorail">, _sinclair_typebox.TLiteral<"airport_express">, _sinclair_typebox.TLiteral<"other">]>;
        readonly ApiLineStatus: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"partially_operating">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">, _sinclair_typebox.TLiteral<"closed">]>;
        readonly ApiLine: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            text_color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            short_name: _sinclair_typebox.TString;
            mode: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"metro">, _sinclair_typebox.TLiteral<"suburban_rail">, _sinclair_typebox.TLiteral<"light_rail">, _sinclair_typebox.TLiteral<"tram">, _sinclair_typebox.TLiteral<"monorail">, _sinclair_typebox.TLiteral<"airport_express">, _sinclair_typebox.TLiteral<"other">]>;
            status: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"partially_operating">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">, _sinclair_typebox.TLiteral<"closed">]>;
            loop: _sinclair_typebox.TBoolean;
        }>;
        readonly ApiLineList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            text_color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            short_name: _sinclair_typebox.TString;
            mode: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"metro">, _sinclair_typebox.TLiteral<"suburban_rail">, _sinclair_typebox.TLiteral<"light_rail">, _sinclair_typebox.TLiteral<"tram">, _sinclair_typebox.TLiteral<"monorail">, _sinclair_typebox.TLiteral<"airport_express">, _sinclair_typebox.TLiteral<"other">]>;
            status: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"partially_operating">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">, _sinclair_typebox.TLiteral<"closed">]>;
            loop: _sinclair_typebox.TBoolean;
        }>>>;
        readonly ApiStationStatus: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"out_of_service">, _sinclair_typebox.TLiteral<"closed">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">]>;
        readonly ApiStation: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            location: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            schematic: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                x: _sinclair_typebox.TNumber;
                y: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            status: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"out_of_service">, _sinclair_typebox.TLiteral<"closed">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">]>;
            lines: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            is_interchange: _sinclair_typebox.TBoolean;
        }>;
        readonly ApiStationList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            location: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            schematic: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                x: _sinclair_typebox.TNumber;
                y: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            status: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"operating">, _sinclair_typebox.TLiteral<"out_of_service">, _sinclair_typebox.TLiteral<"closed">, _sinclair_typebox.TLiteral<"under_construction">, _sinclair_typebox.TLiteral<"planned">]>;
            lines: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            is_interchange: _sinclair_typebox.TBoolean;
        }>>>;
        readonly ApiDirectionType: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"linear">, _sinclair_typebox.TLiteral<"loop_inner">, _sinclair_typebox.TLiteral<"loop_outer">]>;
        readonly ApiTimetableStatus: _sinclair_typebox.TObject<{
            timetable_id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            destination_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            is_in_service: _sinclair_typebox.TBoolean;
            first_train: _sinclair_typebox.TString;
            last_train: _sinclair_typebox.TString;
            timezone: _sinclair_typebox.TString;
            now: _sinclair_typebox.TString;
        }>;
        readonly ApiStop: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            sequence: _sinclair_typebox.TNumber;
            is_terminal: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            location: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            schematic: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                x: _sinclair_typebox.TNumber;
                y: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
        }>;
        readonly ApiStopList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            sequence: _sinclair_typebox.TNumber;
            is_terminal: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            location: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            schematic: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                x: _sinclair_typebox.TNumber;
                y: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
        }>>>;
        readonly ApiPattern: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            names: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>>;
            stop_ids: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            origin_stop_id: _sinclair_typebox.TString;
            terminal_stop_id: _sinclair_typebox.TString;
            is_primary: _sinclair_typebox.TBoolean;
            junction_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
        }>;
        readonly ApiPatternList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            names: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>>;
            stop_ids: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            origin_stop_id: _sinclair_typebox.TString;
            terminal_stop_id: _sinclair_typebox.TString;
            is_primary: _sinclair_typebox.TBoolean;
            junction_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            color: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
        }>>>;
        readonly ApiSegmentDirection: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"both">, _sinclair_typebox.TLiteral<"forward">, _sinclair_typebox.TLiteral<"backward">]>;
        readonly ApiTravelTimeSource: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"source">, _sinclair_typebox.TLiteral<"last_train">, _sinclair_typebox.TLiteral<"estimated">]>;
        readonly ApiSegment: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            direction: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"both">, _sinclair_typebox.TLiteral<"forward">, _sinclair_typebox.TLiteral<"backward">]>;
            travel_time_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            travel_time_source: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"source">, _sinclair_typebox.TLiteral<"last_train">, _sinclair_typebox.TLiteral<"estimated">]>>>;
            distance_km: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
        }>;
        readonly ApiSegmentList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            direction: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"both">, _sinclair_typebox.TLiteral<"forward">, _sinclair_typebox.TLiteral<"backward">]>;
            travel_time_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            travel_time_source: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"source">, _sinclair_typebox.TLiteral<"last_train">, _sinclair_typebox.TLiteral<"estimated">]>>>;
            distance_km: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
        }>>>;
        readonly ApiTransfer: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            from_line_id: _sinclair_typebox.TString;
            to_line_id: _sinclair_typebox.TString;
            from_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            to_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            walk_time_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            walk_distance_meters: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            is_out_of_station: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
        }>;
        readonly ApiTransferList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            from_line_id: _sinclair_typebox.TString;
            to_line_id: _sinclair_typebox.TString;
            from_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            to_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            walk_time_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            walk_distance_meters: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            is_out_of_station: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
        }>>>;
        readonly ApiTimetable: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            stop_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            destination_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            origin_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            pattern_id: _sinclair_typebox.TString;
            direction_type: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"linear">, _sinclair_typebox.TLiteral<"loop_inner">, _sinclair_typebox.TLiteral<"loop_outer">]>>>;
            direction_label: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            first_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            last_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            is_arrival: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            service: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
        }>;
        readonly ApiTimetableList: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            stop_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
            destination_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            origin_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            pattern_id: _sinclair_typebox.TString;
            direction_type: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"linear">, _sinclair_typebox.TLiteral<"loop_inner">, _sinclair_typebox.TLiteral<"loop_outer">]>>>;
            direction_label: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            first_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            last_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            is_arrival: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            service: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
        }>>>;
        readonly ApiStationDetail: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            location: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            schematic: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                x: _sinclair_typebox.TNumber;
                y: _sinclair_typebox.TNumber;
                crs: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            }>>>;
            status: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                timetable_id: _sinclair_typebox.TString;
                station_id: _sinclair_typebox.TString;
                line_id: _sinclair_typebox.TString;
                destination_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                is_in_service: _sinclair_typebox.TBoolean;
                first_train: _sinclair_typebox.TString;
                last_train: _sinclair_typebox.TString;
                timezone: _sinclair_typebox.TString;
                now: _sinclair_typebox.TString;
            }>>>;
            lines: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            is_interchange: _sinclair_typebox.TBoolean;
            transfers: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                id: _sinclair_typebox.TString;
                station_id: _sinclair_typebox.TString;
                from_line_id: _sinclair_typebox.TString;
                to_line_id: _sinclair_typebox.TString;
                from_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                to_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                walk_time_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
                walk_distance_meters: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
                is_out_of_station: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            }>>>;
            timetables: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                id: _sinclair_typebox.TString;
                station_id: _sinclair_typebox.TString;
                stop_id: _sinclair_typebox.TString;
                line_id: _sinclair_typebox.TString;
                destination_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                origin_stop_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                pattern_id: _sinclair_typebox.TString;
                direction_type: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"linear">, _sinclair_typebox.TLiteral<"loop_inner">, _sinclair_typebox.TLiteral<"loop_outer">]>>>;
                direction_label: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                first_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
                last_train: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
                is_arrival: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
                service: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            }>>>;
        }>;
        readonly ApiFareMatrix: _sinclair_typebox.TObject<{
            currency: _sinclair_typebox.TString;
            unit: _sinclair_typebox.TString;
            station_ids: _sinclair_typebox.TArray<_sinclair_typebox.TString>;
            fares: _sinclair_typebox.TArray<_sinclair_typebox.TArray<_sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>>>;
        }>;
        readonly ApiFareRow: _sinclair_typebox.TObject<{
            from_station_id: _sinclair_typebox.TString;
            currency: _sinclair_typebox.TString;
            unit: _sinclair_typebox.TString;
            fares: _sinclair_typebox.TRecord<_sinclair_typebox.TString, _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>>;
        }>;
        readonly ApiCity: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            country: _sinclair_typebox.TString;
            population: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
            area: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
            location: _sinclair_typebox.TUnion<[_sinclair_typebox.TObject<{
                type: _sinclair_typebox.TLiteral<"Point">;
                coordinates: _sinclair_typebox.TTuple<[_sinclair_typebox.TNumber, _sinclair_typebox.TNumber]>;
            }>, _sinclair_typebox.TNull]>;
        }>;
        readonly ApiRoutingDefaults: _sinclair_typebox.TObject<{
            weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"time">, _sinclair_typebox.TLiteral<"distance">]>;
            default_transfer_seconds: _sinclair_typebox.TNumber;
            max_transfer_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
        }>;
        readonly ApiNetwork: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            name: _sinclair_typebox.TString;
            names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>;
            city: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                id: _sinclair_typebox.TString;
                name: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                    zh: _sinclair_typebox.TString;
                    en: _sinclair_typebox.TString;
                }>>;
                country: _sinclair_typebox.TString;
                population: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
                area: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
                location: _sinclair_typebox.TUnion<[_sinclair_typebox.TObject<{
                    type: _sinclair_typebox.TLiteral<"Point">;
                    coordinates: _sinclair_typebox.TTuple<[_sinclair_typebox.TNumber, _sinclair_typebox.TNumber]>;
                }>, _sinclair_typebox.TNull]>;
            }>>;
            country_code: _sinclair_typebox.TString;
            currency: _sinclair_typebox.TString;
            timezone: _sinclair_typebox.TString;
            coordinate_system: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
            default_units: _sinclair_typebox.TObject<{
                distance: _sinclair_typebox.TString;
                time: _sinclair_typebox.TString;
                speed: _sinclair_typebox.TString;
            }>;
            routing: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"time">, _sinclair_typebox.TLiteral<"distance">]>;
                default_transfer_seconds: _sinclair_typebox.TNumber;
                max_transfer_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            }>>;
            synced_at: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
        }>;
        readonly ApiNetworkList: _sinclair_typebox.TObject<{
            networks: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                id: _sinclair_typebox.TString;
                name: _sinclair_typebox.TString;
                names: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                    zh: _sinclair_typebox.TString;
                    en: _sinclair_typebox.TString;
                }>>;
                city: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                    id: _sinclair_typebox.TString;
                    name: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                        zh: _sinclair_typebox.TString;
                        en: _sinclair_typebox.TString;
                    }>>;
                    country: _sinclair_typebox.TString;
                    population: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
                    area: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
                    location: _sinclair_typebox.TUnion<[_sinclair_typebox.TObject<{
                        type: _sinclair_typebox.TLiteral<"Point">;
                        coordinates: _sinclair_typebox.TTuple<[_sinclair_typebox.TNumber, _sinclair_typebox.TNumber]>;
                    }>, _sinclair_typebox.TNull]>;
                }>>;
                country_code: _sinclair_typebox.TString;
                currency: _sinclair_typebox.TString;
                timezone: _sinclair_typebox.TString;
                coordinate_system: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"wgs84">, _sinclair_typebox.TLiteral<"gcj02">, _sinclair_typebox.TLiteral<"bd09">, _sinclair_typebox.TLiteral<"schematic">, _sinclair_typebox.TLiteral<"none">]>;
                default_units: _sinclair_typebox.TObject<{
                    distance: _sinclair_typebox.TString;
                    time: _sinclair_typebox.TString;
                    speed: _sinclair_typebox.TString;
                }>;
                routing: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                    weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"time">, _sinclair_typebox.TLiteral<"distance">]>;
                    default_transfer_seconds: _sinclair_typebox.TNumber;
                    max_transfer_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
                }>>;
                synced_at: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            }>>>;
        }>;
        readonly ApiStopNode: _sinclair_typebox.TObject<{
            id: _sinclair_typebox.TString;
            station_id: _sinclair_typebox.TString;
            line_id: _sinclair_typebox.TString;
        }>;
        readonly ApiStopEdge: _sinclair_typebox.TObject<{
            from: _sinclair_typebox.TString;
            to: _sinclair_typebox.TString;
            kind: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"ride">, _sinclair_typebox.TLiteral<"transfer">]>;
            line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            distance_km: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            weight: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
        }>;
        readonly ApiStopGraph: _sinclair_typebox.TObject<{
            network_id: _sinclair_typebox.TString;
            weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"seconds">, _sinclair_typebox.TLiteral<"km">]>;
            routing: _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"time">, _sinclair_typebox.TLiteral<"distance">]>;
                default_transfer_seconds: _sinclair_typebox.TNumber;
                max_transfer_seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            }>>;
            nodes: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                id: _sinclair_typebox.TString;
                station_id: _sinclair_typebox.TString;
                line_id: _sinclair_typebox.TString;
            }>>>;
            edges: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                from: _sinclair_typebox.TString;
                to: _sinclair_typebox.TString;
                kind: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"ride">, _sinclair_typebox.TLiteral<"transfer">]>;
                line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                seconds: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
                distance_km: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
                weight: _sinclair_typebox.TOptional<_sinclair_typebox.TNumber>;
            }>>>;
        }>;
        readonly ApiRideLeg: _sinclair_typebox.TObject<{
            kind: _sinclair_typebox.TLiteral<"ride">;
            line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            seconds: _sinclair_typebox.TNumber;
            station_ids: _sinclair_typebox.TOptional<_sinclair_typebox.TArray<_sinclair_typebox.TString>>;
            pattern_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            headsign_station_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            headsign_names: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>>;
        }>;
        readonly ApiTransferLeg: _sinclair_typebox.TObject<{
            kind: _sinclair_typebox.TLiteral<"transfer">;
            line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            seconds: _sinclair_typebox.TNumber;
            same_line_direction_change: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
        }>;
        readonly ApiRouteLeg: _sinclair_typebox.TUnion<[_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            kind: _sinclair_typebox.TLiteral<"ride">;
            line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            seconds: _sinclair_typebox.TNumber;
            station_ids: _sinclair_typebox.TOptional<_sinclair_typebox.TArray<_sinclair_typebox.TString>>;
            pattern_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            headsign_station_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            headsign_names: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                zh: _sinclair_typebox.TString;
                en: _sinclair_typebox.TString;
            }>>>;
        }>>, _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
            kind: _sinclair_typebox.TLiteral<"transfer">;
            line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
            from_stop_id: _sinclair_typebox.TString;
            to_stop_id: _sinclair_typebox.TString;
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            seconds: _sinclair_typebox.TNumber;
            same_line_direction_change: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
        }>>]>;
        readonly ApiRoutePlan: _sinclair_typebox.TObject<{
            from_station_id: _sinclair_typebox.TString;
            to_station_id: _sinclair_typebox.TString;
            total_seconds: _sinclair_typebox.TNumber;
            transfers: _sinclair_typebox.TNumber;
            legs: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TUnion<[_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                kind: _sinclair_typebox.TLiteral<"ride">;
                line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                from_stop_id: _sinclair_typebox.TString;
                to_stop_id: _sinclair_typebox.TString;
                from_station_id: _sinclair_typebox.TString;
                to_station_id: _sinclair_typebox.TString;
                seconds: _sinclair_typebox.TNumber;
                station_ids: _sinclair_typebox.TOptional<_sinclair_typebox.TArray<_sinclair_typebox.TString>>;
                pattern_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                headsign_station_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                headsign_names: _sinclair_typebox.TOptional<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                    zh: _sinclair_typebox.TString;
                    en: _sinclair_typebox.TString;
                }>>>;
            }>>, _sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                kind: _sinclair_typebox.TLiteral<"transfer">;
                line_id: _sinclair_typebox.TOptional<_sinclair_typebox.TString>;
                from_stop_id: _sinclair_typebox.TString;
                to_stop_id: _sinclair_typebox.TString;
                from_station_id: _sinclair_typebox.TString;
                to_station_id: _sinclair_typebox.TString;
                seconds: _sinclair_typebox.TNumber;
                same_line_direction_change: _sinclair_typebox.TOptional<_sinclair_typebox.TBoolean>;
            }>>]>>>;
            fare: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
            currency: _sinclair_typebox.TUnion<[_sinclair_typebox.TString, _sinclair_typebox.TNull]>;
        }>;
        readonly ApiTravelTimeEntry: _sinclair_typebox.TObject<{
            station_id: _sinclair_typebox.TString;
            seconds: _sinclair_typebox.TNumber;
        }>;
        readonly ApiTravelTimes: _sinclair_typebox.TObject<{
            from_station_id: _sinclair_typebox.TString;
            weight: _sinclair_typebox.TUnion<[_sinclair_typebox.TLiteral<"seconds">, _sinclair_typebox.TLiteral<"km">]>;
            within: _sinclair_typebox.TUnion<[_sinclair_typebox.TNumber, _sinclair_typebox.TNull]>;
            stations: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                station_id: _sinclair_typebox.TString;
                seconds: _sinclair_typebox.TNumber;
            }>>>;
        }>;
        readonly ApiNearestStation: _sinclair_typebox.TObject<{
            station_id: _sinclair_typebox.TString;
            distance_km: _sinclair_typebox.TNumber;
        }>;
        readonly ApiNearestStations: _sinclair_typebox.TObject<{
            network_id: _sinclair_typebox.TString;
            query: _sinclair_typebox.TObject<{
                lon: _sinclair_typebox.TNumber;
                lat: _sinclair_typebox.TNumber;
            }>;
            stations: _sinclair_typebox.TArray<_sinclair_typebox.TRefUnsafe<_sinclair_typebox.TObject<{
                station_id: _sinclair_typebox.TString;
                distance_km: _sinclair_typebox.TNumber;
            }>>>;
        }>;
        readonly ApiHealth: _sinclair_typebox.TObject<{
            status: _sinclair_typebox.TLiteral<"ok">;
        }>;
        readonly ApiError: _sinclair_typebox.TObject<{
            error: _sinclair_typebox.TString;
        }>;
    };
    error: {};
} & {
    typebox: {};
    error: {};
} & {
    typebox: {};
    error: {};
}, {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
} & {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
} & {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {
    api: {
        health: {
            get: {
                body: unknown;
                params: {};
                query: unknown;
                headers: unknown;
                response: {
                    200: {
                        status: "ok";
                    };
                    422: {
                        type: "validation";
                        on: string;
                        summary?: string;
                        message?: string;
                        found?: unknown;
                        property?: string;
                        expected?: string;
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            get: {
                body: unknown;
                params: {};
                query: unknown;
                headers: unknown;
                response: {
                    200: {
                        networks: {
                            synced_at?: string | undefined;
                            id: string;
                            name: string;
                            names: {
                                zh: string;
                                en: string;
                            };
                            timezone: string;
                            currency: string;
                            city: {
                                id: string;
                                name: {
                                    zh: string;
                                    en: string;
                                };
                                location: {
                                    type: "Point";
                                    coordinates: [number, number];
                                } | null;
                                country: string;
                                population: number | null;
                                area: number | null;
                            };
                            country_code: string;
                            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                            default_units: {
                                time: string;
                                distance: string;
                                speed: string;
                            };
                            routing: {
                                max_transfer_seconds?: number | undefined;
                                weight: "time" | "distance";
                                default_transfer_seconds: number;
                            };
                        }[];
                    };
                    422: {
                        type: "validation";
                        on: string;
                        summary?: string;
                        message?: string;
                        found?: unknown;
                        property?: string;
                        expected?: string;
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            synced_at?: string | undefined;
                            id: string;
                            name: string;
                            names: {
                                zh: string;
                                en: string;
                            };
                            timezone: string;
                            currency: string;
                            city: {
                                id: string;
                                name: {
                                    zh: string;
                                    en: string;
                                };
                                location: {
                                    type: "Point";
                                    coordinates: [number, number];
                                } | null;
                                country: string;
                                population: number | null;
                                area: number | null;
                            };
                            country_code: string;
                            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                            default_units: {
                                time: string;
                                distance: string;
                                speed: string;
                            };
                            routing: {
                                max_transfer_seconds?: number | undefined;
                                weight: "time" | "distance";
                                default_transfer_seconds: number;
                            };
                        };
                        404: {
                            error: string;
                        };
                        422: {
                            type: "validation";
                            on: string;
                            summary?: string;
                            message?: string;
                            found?: unknown;
                            property?: string;
                            expected?: string;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                lines: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                color?: string | undefined;
                                text_color?: string | undefined;
                                id: string;
                                name: string;
                                names: {
                                    zh: string;
                                    en: string;
                                };
                                short_name: string;
                                mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
                                status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
                                loop: boolean;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                stations: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                schematic?: {
                                    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                    x: number;
                                    y: number;
                                } | undefined;
                                location?: {
                                    lon: number;
                                    lat: number;
                                    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                } | undefined;
                                id: string;
                                name: string;
                                names: {
                                    zh: string;
                                    en: string;
                                };
                                status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
                                lines: string[];
                                is_interchange: boolean;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                stations: {
                    ":stationId": {
                        get: {
                            body: unknown;
                            params: {
                                id: string;
                                stationId: string;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    schematic?: {
                                        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                        x: number;
                                        y: number;
                                    } | undefined;
                                    location?: {
                                        lon: number;
                                        lat: number;
                                        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                    } | undefined;
                                    id: string;
                                    name: string;
                                    names: {
                                        zh: string;
                                        en: string;
                                    };
                                    status: {
                                        destination_stop_id?: string | undefined;
                                        timetable_id: string;
                                        station_id: string;
                                        line_id: string;
                                        is_in_service: boolean;
                                        first_train: string;
                                        last_train: string;
                                        timezone: string;
                                        now: string;
                                    }[];
                                    lines: string[];
                                    is_interchange: boolean;
                                    transfers: {
                                        from_stop_id?: string | undefined;
                                        to_stop_id?: string | undefined;
                                        walk_time_seconds?: number | undefined;
                                        walk_distance_meters?: number | undefined;
                                        is_out_of_station?: boolean | undefined;
                                        id: string;
                                        station_id: string;
                                        from_line_id: string;
                                        to_line_id: string;
                                    }[];
                                    timetables: {
                                        destination_stop_id?: string | undefined;
                                        origin_stop_id?: string | undefined;
                                        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
                                        direction_label?: string | undefined;
                                        is_arrival?: boolean | undefined;
                                        service?: string | undefined;
                                        id: string;
                                        station_id: string;
                                        line_id: string;
                                        first_train: string[];
                                        last_train: string[];
                                        stop_id: string;
                                        pattern_id: string;
                                    }[];
                                };
                                404: {
                                    error: string;
                                };
                                422: {
                                    type: "validation";
                                    on: string;
                                    summary?: string;
                                    message?: string;
                                    found?: unknown;
                                    property?: string;
                                    expected?: string;
                                };
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                stops: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                schematic?: {
                                    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                    x: number;
                                    y: number;
                                } | undefined;
                                location?: {
                                    lon: number;
                                    lat: number;
                                    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
                                } | undefined;
                                is_terminal?: boolean | undefined;
                                id: string;
                                station_id: string;
                                line_id: string;
                                sequence: number;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                patterns: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                name?: string | undefined;
                                names?: {
                                    zh: string;
                                    en: string;
                                } | undefined;
                                color?: string | undefined;
                                junction_stop_id?: string | undefined;
                                id: string;
                                line_id: string;
                                stop_ids: string[];
                                origin_stop_id: string;
                                terminal_stop_id: string;
                                is_primary: boolean;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                segments: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                travel_time_seconds?: number | undefined;
                                travel_time_source?: "last_train" | "source" | "estimated" | undefined;
                                distance_km?: number | undefined;
                                id: string;
                                line_id: string;
                                from_stop_id: string;
                                to_stop_id: string;
                                from_station_id: string;
                                to_station_id: string;
                                direction: "both" | "forward" | "backward";
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                transfers: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                from_stop_id?: string | undefined;
                                to_stop_id?: string | undefined;
                                walk_time_seconds?: number | undefined;
                                walk_distance_meters?: number | undefined;
                                is_out_of_station?: boolean | undefined;
                                id: string;
                                station_id: string;
                                from_line_id: string;
                                to_line_id: string;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                timetables: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                destination_stop_id?: string | undefined;
                                origin_stop_id?: string | undefined;
                                direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
                                direction_label?: string | undefined;
                                is_arrival?: boolean | undefined;
                                service?: string | undefined;
                                id: string;
                                station_id: string;
                                line_id: string;
                                first_train: string[];
                                last_train: string[];
                                stop_id: string;
                                pattern_id: string;
                            }[];
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                fares: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            from?: string | undefined;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                currency: string;
                                unit: string;
                                station_ids: string[];
                                fares: (number | null)[][];
                            } | {
                                from_station_id: string;
                                currency: string;
                                unit: string;
                                fares: {
                                    [x: string]: number | null;
                                };
                            };
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                graph: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            weight?: "time" | "distance" | undefined;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                weight: "seconds" | "km";
                                routing: {
                                    max_transfer_seconds?: number | undefined;
                                    weight: "time" | "distance";
                                    default_transfer_seconds: number;
                                };
                                network_id: string;
                                nodes: {
                                    id: string;
                                    station_id: string;
                                    line_id: string;
                                }[];
                                edges: {
                                    line_id?: string | undefined;
                                    distance_km?: number | undefined;
                                    weight?: number | undefined;
                                    seconds?: number | undefined;
                                    from: string;
                                    to: string;
                                    kind: "ride" | "transfer";
                                }[];
                            };
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                route: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            weight?: "time" | "distance" | undefined;
                            from: string;
                            to: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                from_station_id: string;
                                to_station_id: string;
                                transfers: number;
                                currency: string | null;
                                total_seconds: number;
                                legs: ({
                                    line_id?: string | undefined;
                                    pattern_id?: string | undefined;
                                    station_ids?: string[] | undefined;
                                    headsign_station_id?: string | undefined;
                                    headsign_names?: {
                                        zh: string;
                                        en: string;
                                    } | undefined;
                                    from_stop_id: string;
                                    to_stop_id: string;
                                    from_station_id: string;
                                    to_station_id: string;
                                    kind: "ride";
                                    seconds: number;
                                } | {
                                    line_id?: string | undefined;
                                    same_line_direction_change?: boolean | undefined;
                                    from_stop_id: string;
                                    to_stop_id: string;
                                    from_station_id: string;
                                    to_station_id: string;
                                    kind: "transfer";
                                    seconds: number;
                                })[];
                                fare: number | null;
                            };
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                "travel-times": {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            weight?: "time" | "distance" | undefined;
                            within?: number | undefined;
                            from: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                from_station_id: string;
                                weight: "seconds" | "km";
                                within: number | null;
                                stations: {
                                    station_id: string;
                                    seconds: number;
                                }[];
                            };
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        networks: {
            ":id": {
                nearest: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            k?: number | undefined;
                            lon: number;
                            lat: number;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                network_id: string;
                                stations: {
                                    station_id: string;
                                    distance_km: number;
                                }[];
                                query: {
                                    lon: number;
                                    lat: number;
                                };
                            };
                            404: {
                                error: string;
                            };
                            422: {
                                type: "validation";
                                on: string;
                                summary?: string;
                                message?: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                        };
                    };
                };
            };
        };
    };
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
} & {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
} & {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}>;
type App = ReturnType<typeof createApiApp>;

/**
 * Creates a fully typed Eden Treaty client for the Open Metro API.
 *
 * The client is generated from the server's own Elysia app type, so request
 * bodies, query params and responses are checked end to end with no
 * hand-written contract.
 *
 * @param baseUrl - Base URL of a running API, e.g. `"http://127.0.0.1:8790"`.
 * @param config  - Optional treaty config (custom `fetch`, default headers, etc.).
 *
 * @example
 * ```ts
 * import { createClient } from "openmetro-client";
 *
 * const metro = createClient("http://127.0.0.1:8790");
 *
 * const { data: stations } = await metro.api.networks({ id: "cn-bj" }).stations.get();
 * const { data: plan } = await metro.api
 *   .networks({ id: "cn-bj" })
 *   .route.get({ query: { from: "cn-bj-pingguoyuan", to: "cn-bj-xizhimen" } });
 * ```
 */
declare const createClient: (baseUrl: string, config?: Treaty.Config) => Treaty.Create<App>;
type Client = ReturnType<typeof createClient>;
/**
 * Eden client "nests": the values returned by navigating the treaty client.
 * `NetworkRoute` is what `client.api.networks({ id })` resolves to, and
 * `StationRoute` is what `...networks({ id }).stations({ stationId })` resolves
 * to. Response types are derived from these rather than hand-written.
 */
type NetworksRoute = Client['api']['networks'];
type NetworkRoute = ReturnType<NetworksRoute>;
type StationRoute = ReturnType<NetworkRoute['stations']>;
/**
 * Unwrap one member of a response union: drop the real error body and remove
 * the `error?: undefined` marker Elysia injects on the sibling success member.
 * Payloads that never carry an `error` key — and arrays — pass through as-is.
 *
 * The check must test for "has an `error` key that may be undefined" and then
 * discriminate on the value, rather than `Extract<T, { error?: undefined }>`:
 * `{ error?: undefined }` is a *weak* type, so TypeScript rejects payloads with
 * no `error` property at all and `Extract` silently collapses them to `never`.
 */
type SuccessMember<T> = T extends {
    error?: infer E;
} ? [undefined] extends [E] ? Omit<T, 'error'> : never : T;
/**
 * The success payload of an Eden route method, e.g.
 * `ApiSuccess<Client["api"]["networks"]["get"]>` is `{ networks: ApiNetwork[] }`.
 * Errors (Elysia folds `{ error: string }` bodies into the same union) are
 * stripped, so consumers never have to narrow them away. Exported so third
 * parties can type any route without copying this logic.
 */
type ApiSuccess<Route> = Route extends (...args: any[]) => Promise<infer Response> ? Response extends {
    data: infer Data;
} ? NonNullable<SuccessMember<Data>> : never : never;
/**
 * Entity types derived from the client itself — the single source of truth for
 * consumers. Response shapes flow from the Elysia handlers (which read the
 * Effect schemas in @openmetro/core) through Eden's inference, so a schema
 * change here automatically re-types every consumer; nothing is hand-written.
 */
type ApiNetworksResponse = ApiSuccess<NetworksRoute['get']>;
type ApiNetwork = NonNullable<ApiNetworksResponse['networks'][number]>;
type ApiLine = ApiSuccess<NetworkRoute['lines']['get']>[number];
type ApiStation = ApiSuccess<NetworkRoute['stations']['get']>[number];
type ApiStop = ApiSuccess<NetworkRoute['stops']['get']>[number];
type ApiPattern = ApiSuccess<NetworkRoute['patterns']['get']>[number];
type ApiTimetable = ApiSuccess<NetworkRoute['timetables']['get']>[number];
type ApiTransfer = ApiSuccess<NetworkRoute['transfers']['get']>[number];
type ApiStationDetail = ApiSuccess<StationRoute['get']>;
type ApiRoutePlan = ApiSuccess<NetworkRoute['route']['get']>;
/** The raw mode/status/direction enums, re-derived from the entity shapes. */
type ApiLineMode = NonNullable<ApiLine['mode']>;
type ApiLineStatus = NonNullable<ApiLine['status']>;
type ApiDirectionType = NonNullable<ApiTimetable['direction_type']>;
type ApiStationRecordStatus = NonNullable<ApiStation['status']>;

export { type ApiDirectionType, type ApiLine, type ApiLineMode, type ApiLineStatus, type ApiNetwork, type ApiNetworksResponse, type ApiPattern, type ApiRoutePlan, type ApiStation, type ApiStationDetail, type ApiStationRecordStatus, type ApiStop, type ApiSuccess, type ApiTimetable, type ApiTransfer, type App, type Client, createClient };
