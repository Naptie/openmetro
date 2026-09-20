import { type Static, t } from 'elysia';

/**
 * TypeBox wire schemas for every HTTP response shape.
 *
 * These are the public compatibility surface: Elysia validates every response
 * against them at runtime and the OpenAPI document is generated from them, so
 * `openapi.json` can never drift from what the server actually sends. Names are
 * a public artifact — consumers codegen types from `components.schemas` and may
 * import these `Static<typeof ApiX>` shapes for their own contracts.
 *
 * Conventions (each mirrors what the projections actually emit):
 * - Fields whose canonical value may be absent on the wire are `t.Optional`
 *   (JSON drops `undefined` keys; validation accepts either form).
 * - Fields that are always present but may be `null` are explicit
 *   `t.Union([..., t.Null()])` unions.
 * - Effect `Schema` in `src/schema/*` owns the canonical data files; these
 *   TypeBox schemas own the wire. They are deliberately written out, not
 *   derived, because the wire trims provenance (`source_ids`, `extras`,
 *   geometry) and denormalizes (`lines`, `is_interchange`, fare rows).
 */

/** Coordinate reference system (canonical `Crs` projected as-is). */
export const ApiCrs = t.Union(
  [
    t.Literal('wgs84'),
    t.Literal('gcj02'),
    t.Literal('bd09'),
    t.Literal('schematic'),
    t.Literal('none')
  ],
  { $id: 'ApiCrs' }
);

/** Required zh/en multilingual names (`MultilingualName` on the wire). */
export const ApiNames = t.Object({ zh: t.String(), en: t.String() }, { $id: 'ApiNames' });

/** Real-world geographic coordinate with its datum. */
export const ApiGeoPoint = t.Object(
  { lon: t.Number(), lat: t.Number(), crs: ApiCrs },
  { $id: 'ApiGeoPoint' }
);

/** Source-map pixel-space coordinate (schematic maps). */
export const ApiSchematicPoint = t.Object(
  { x: t.Number(), y: t.Number(), crs: ApiCrs },
  { $id: 'ApiSchematicPoint' }
);

/** Transit mode of a line (canonical `LineMode`). */
export const ApiLineMode = t.Union(
  [
    t.Literal('metro'),
    t.Literal('suburban_rail'),
    t.Literal('light_rail'),
    t.Literal('tram'),
    t.Literal('monorail'),
    t.Literal('airport_express'),
    t.Literal('other')
  ],
  { $id: 'ApiLineMode' }
);

/** Operating status of a line (canonical `LineStatus`). */
export const ApiLineStatus = t.Union(
  [t.Literal('operating'), t.Literal('under_construction')],
  { $id: 'ApiLineStatus' }
);

/** A metro line. `short_name` is mandatory and not guaranteed ASCII or numeric. */
export const ApiLine = t.Object(
  {
    id: t.String(),
    name: t.String(),
    names: t.Ref(ApiNames),
    color: t.Optional(t.String()),
    text_color: t.Optional(t.String()),
    short_name: t.String(),
    mode: ApiLineMode,
    status: ApiLineStatus,
    loop: t.Boolean()
  },
  { $id: 'ApiLine' }
);

export const ApiLineList = t.Array(t.Ref(ApiLine), { $id: 'ApiLineList' });

/** Operating status of a station (canonical `StationStatus`). */
export const ApiStationStatus = t.Union(
  [
    t.Literal('operating'),
    t.Literal('out_of_service'),
    t.Literal('under_construction')
  ],
  { $id: 'ApiStationStatus' }
);

/** A station: identity, coordinates, and the lines that call there. */
export const ApiStation = t.Object(
  {
    id: t.String(),
    name: t.String(),
    names: t.Ref(ApiNames),
    location: t.Optional(t.Ref(ApiGeoPoint)),
    schematic: t.Optional(t.Ref(ApiSchematicPoint)),
    status: ApiStationStatus,
    lines: t.Array(t.String()),
    is_interchange: t.Boolean()
  },
  { $id: 'ApiStation' }
);

export const ApiStationList = t.Array(t.Ref(ApiStation), { $id: 'ApiStationList' });

/** Direction type for timetable entries (`linear` | `loop_inner` | `loop_outer`). */
export const ApiDirectionType = t.Union(
  [t.Literal('linear'), t.Literal('loop_inner'), t.Literal('loop_outer')],
  { $id: 'ApiDirectionType' }
);

/** First/last train availability for one timetable record at "now". */
export const ApiTimetableStatus = t.Object(
  {
    timetable_id: t.String(),
    station_id: t.String(),
    line_id: t.String(),
    destination_stop_id: t.Optional(t.String()),
    is_in_service: t.Boolean(),
    first_train: t.String(),
    last_train: t.String(),
    timezone: t.String(),
    now: t.String()
  },
  { $id: 'ApiTimetableStatus' }
);

/** A per-line stop occurrence (routing node). */
export const ApiStop = t.Object(
  {
    id: t.String(),
    station_id: t.String(),
    line_id: t.String(),
    sequence: t.Number(),
    is_terminal: t.Optional(t.Boolean()),
    location: t.Optional(t.Ref(ApiGeoPoint)),
    schematic: t.Optional(t.Ref(ApiSchematicPoint))
  },
  { $id: 'ApiStop' }
);

export const ApiStopList = t.Array(t.Ref(ApiStop), { $id: 'ApiStopList' });

/** A route alignment (service pattern) belonging to a line. */
export const ApiPattern = t.Object(
  {
    id: t.String(),
    line_id: t.String(),
    name: t.Optional(t.String()),
    names: t.Optional(t.Ref(ApiNames)),
    stop_ids: t.Array(t.String()),
    origin_stop_id: t.String(),
    terminal_stop_id: t.String(),
    is_primary: t.Boolean(),
    junction_stop_id: t.Optional(t.String()),
    color: t.Optional(t.String())
  },
  { $id: 'ApiPattern' }
);

export const ApiPatternList = t.Array(t.Ref(ApiPattern), { $id: 'ApiPatternList' });

/** Direction of traversal for a segment. */
export const ApiSegmentDirection = t.Union(
  [t.Literal('both'), t.Literal('forward'), t.Literal('backward')],
  { $id: 'ApiSegmentDirection' }
);

/** How a segment's travel time was obtained. */
export const ApiTravelTimeSource = t.Union(
  [t.Literal('source'), t.Literal('planner'), t.Literal('last_train'), t.Literal('estimated')],
  { $id: 'ApiTravelTimeSource' }
);

/** A ride edge between two consecutive stops on one line. */
export const ApiSegment = t.Object(
  {
    id: t.String(),
    line_id: t.String(),
    from_stop_id: t.String(),
    to_stop_id: t.String(),
    from_station_id: t.String(),
    to_station_id: t.String(),
    direction: ApiSegmentDirection,
    travel_time_seconds: t.Optional(t.Number()),
    travel_time_source: t.Optional(t.Ref(ApiTravelTimeSource)),
    distance_km: t.Optional(t.Number())
  },
  { $id: 'ApiSegment' }
);

export const ApiSegmentList = t.Array(t.Ref(ApiSegment), { $id: 'ApiSegmentList' });

/** A directional transfer walk edge at a station. */
export const ApiTransfer = t.Object(
  {
    id: t.String(),
    station_id: t.String(),
    from_line_id: t.String(),
    to_line_id: t.String(),
    from_stop_id: t.Optional(t.String()),
    to_stop_id: t.Optional(t.String()),
    walk_time_seconds: t.Optional(t.Number()),
    walk_distance_meters: t.Optional(t.Number()),
    is_out_of_station: t.Optional(t.Boolean())
  },
  { $id: 'ApiTransfer' }
);

export const ApiTransferList = t.Array(t.Ref(ApiTransfer), { $id: 'ApiTransferList' });

/** First/last train times for one station, line and direction. */
export const ApiTimetable = t.Object(
  {
    id: t.String(),
    station_id: t.String(),
    stop_id: t.String(),
    line_id: t.String(),
    destination_stop_id: t.Optional(t.String()),
    origin_stop_id: t.Optional(t.String()),
    pattern_id: t.String(),
    direction_type: t.Optional(t.Ref(ApiDirectionType)),
    direction_label: t.Optional(t.String()),
    first_train: t.Array(t.String()),
    last_train: t.Array(t.String()),
    is_arrival: t.Optional(t.Boolean()),
    service: t.Optional(t.String())
  },
  { $id: 'ApiTimetable' }
);

export const ApiTimetableList = t.Array(t.Ref(ApiTimetable), { $id: 'ApiTimetableList' });

/**
 * Station detail: the `ApiStation` fields plus transfers, timetables and live
 * in-service status. The `status` key is intentionally the per-timetable
 * status array (it overrides the station's own status string, which is only
 * exposed by the collection route).
 */
export const ApiStationDetail = t.Object(
  {
    id: t.String(),
    name: t.String(),
    names: t.Ref(ApiNames),
    location: t.Optional(t.Ref(ApiGeoPoint)),
    schematic: t.Optional(t.Ref(ApiSchematicPoint)),
    status: t.Array(t.Ref(ApiTimetableStatus)),
    lines: t.Array(t.String()),
    is_interchange: t.Boolean(),
    transfers: t.Array(t.Ref(ApiTransfer)),
    timetables: t.Array(t.Ref(ApiTimetable))
  },
  { $id: 'ApiStationDetail' }
);

/** Full origin-destination fare matrix (dense, `null` for unpublished pairs). */
export const ApiFareMatrix = t.Object(
  {
    currency: t.String(),
    unit: t.String(),
    station_ids: t.Array(t.String()),
    fares: t.Array(t.Array(t.Union([t.Number(), t.Null()])))
  },
  { $id: 'ApiFareMatrix' }
);

/** One origin's fare row, as returned by `/fares?from=<station>`. */
export const ApiFareRow = t.Object(
  {
    from_station_id: t.String(),
    currency: t.String(),
    unit: t.String(),
    fares: t.Record(t.String(), t.Union([t.Number(), t.Null()]))
  },
  { $id: 'ApiFareRow' }
);

/** City metadata carried by `ApiNetwork`. */
export const ApiCity = t.Object(
  {
    id: t.String(),
    name: t.Ref(ApiNames),
    country: t.String(),
    population: t.Union([t.Number(), t.Null()]),
    area: t.Union([t.Number(), t.Null()]),
    location: t.Union([
      t.Object({
        type: t.Literal('Point'),
        coordinates: t.Tuple([t.Number(), t.Number()])
      }),
      t.Null()
    ])
  },
  { $id: 'ApiCity' }
);

/** Routing defaults for a network. */
export const ApiRoutingDefaults = t.Object(
  {
    weight: t.Union([t.Literal('time'), t.Literal('distance')]),
    default_transfer_seconds: t.Number(),
    max_transfer_seconds: t.Optional(t.Number())
  },
  { $id: 'ApiRoutingDefaults' }
);

/** Precision of one published metric value. */
export const ApiValuePrecision = t.Union([
  t.Literal('official'),
  t.Literal('derived'),
  t.Literal('default')
]);

/** Aggregate quality of one data layer. */
export const ApiLayerQuality = t.Object(
  {
    precision: ApiValuePrecision,
    coverage: t.Number(),
    status: t.Union([
      t.Literal('complete'),
      t.Literal('partial'),
      t.Literal('derived'),
      t.Literal('unavailable')
    ]),
    counts: t.Record(t.String(), t.Number())
  },
  { $id: 'ApiLayerQuality' }
);

/** Per-layer precision / coverage derived from canonical records. */
export const ApiNetworkQuality = t.Object(
  {
    topology: t.Ref(ApiLayerQuality),
    coordinates: t.Ref(ApiLayerQuality),
    names: t.Ref(ApiLayerQuality),
    segment_times: t.Ref(ApiLayerQuality),
    segment_distances: t.Ref(ApiLayerQuality),
    transfer_times: t.Ref(ApiLayerQuality),
    timetables: t.Ref(ApiLayerQuality),
    schematic: t.Ref(ApiLayerQuality),
    fares: t.Optional(t.Ref(ApiLayerQuality))
  },
  { $id: 'ApiNetworkQuality' }
);

/** One network's metadata. `name` is the primary (Chinese) name; `names` always carries zh + en. */
export const ApiNetwork = t.Object(
  {
    id: t.String(),
    name: t.String(),
    names: t.Ref(ApiNames),
    city: t.Ref(ApiCity),
    country_code: t.String(),
    currency: t.String(),
    timezone: t.String(),
    coordinate_system: ApiCrs,
    default_units: t.Object(
      { distance: t.String(), time: t.String(), speed: t.String() },
      { $id: 'ApiDefaultUnits' }
    ),
    routing: t.Ref(ApiRoutingDefaults),
    /** Per-layer data quality; present when the canonical network carries it. */
    quality: t.Optional(t.Ref(ApiNetworkQuality)),
    /** Last sync time (max file `generated_at`); detail route only. */
    synced_at: t.Optional(t.String())
  },
  { $id: 'ApiNetwork' }
);

/** `/api/networks` response: a list of network metadata. */
export const ApiNetworkList = t.Object(
  { networks: t.Array(t.Ref(ApiNetwork)) },
  { $id: 'ApiNetworkList' }
);

/** A stop-level graph node. */
export const ApiStopNode = t.Object(
  { id: t.String(), station_id: t.String(), line_id: t.String() },
  { $id: 'ApiStopNode' }
);

/** A stop-level graph edge (ride or transfer walk), with resolved weight. */
export const ApiStopEdge = t.Object(
  {
    from: t.String(),
    to: t.String(),
    kind: t.Union([t.Literal('ride'), t.Literal('transfer')]),
    line_id: t.Optional(t.String()),
    seconds: t.Optional(t.Number()),
    distance_km: t.Optional(t.Number()),
    weight: t.Optional(t.Number())
  },
  { $id: 'ApiStopEdge' }
);

/** The assembled stop graph returned by `/graph`. */
export const ApiStopGraph = t.Object(
  {
    network_id: t.String(),
    weight: t.Union([t.Literal('seconds'), t.Literal('km')]),
    routing: t.Ref(ApiRoutingDefaults),
    nodes: t.Array(t.Ref(ApiStopNode)),
    edges: t.Array(t.Ref(ApiStopEdge))
  },
  { $id: 'ApiStopGraph' }
);

/** One leg of a route plan: a ride on a single line, or a transfer walk. */
export const ApiRideLeg = t.Object(
  {
    kind: t.Literal('ride'),
    line_id: t.Optional(t.String()),
    from_stop_id: t.String(),
    to_stop_id: t.String(),
    from_station_id: t.String(),
    to_station_id: t.String(),
    seconds: t.Number(),
    station_ids: t.Optional(t.Array(t.String())),
    // Headsign comes from published timetables; absent on loop lines.
    pattern_id: t.Optional(t.String()),
    headsign_station_id: t.Optional(t.String()),
    headsign_names: t.Optional(t.Ref(ApiNames))
  },
  { $id: 'ApiRideLeg' }
);

export const ApiTransferLeg = t.Object(
  {
    kind: t.Literal('transfer'),
    line_id: t.Optional(t.String()),
    from_stop_id: t.String(),
    to_stop_id: t.String(),
    from_station_id: t.String(),
    to_station_id: t.String(),
    seconds: t.Number(),
    /** Same-station direction change when the boarding service cannot ride through. */
    same_line_direction_change: t.Optional(t.Boolean())
  },
  { $id: 'ApiTransferLeg' }
);

export const ApiRouteLeg = t.Union([t.Ref(ApiRideLeg), t.Ref(ApiTransferLeg)], {
  $id: 'ApiRouteLeg'
});

/** A station-to-station route plan with legs, total time and transfer count. */
export const ApiRoutePlan = t.Object(
  {
    from_station_id: t.String(),
    to_station_id: t.String(),
    total_seconds: t.Number(),
    transfers: t.Number(),
    legs: t.Array(t.Ref(ApiRouteLeg)),
    fare: t.Union([t.Number(), t.Null()]),
    currency: t.Union([t.String(), t.Null()])
  },
  { $id: 'ApiRoutePlan' }
);

/** One entry of a travel-time isochrone. */
export const ApiTravelTimeEntry = t.Object(
  { station_id: t.String(), seconds: t.Number() },
  { $id: 'ApiTravelTimeEntry' }
);

/** Travel-time isochrone from one station to every other station. */
export const ApiTravelTimes = t.Object(
  {
    from_station_id: t.String(),
    weight: t.Union([t.Literal('seconds'), t.Literal('km')]),
    within: t.Union([t.Number(), t.Null()]),
    stations: t.Array(t.Ref(ApiTravelTimeEntry))
  },
  { $id: 'ApiTravelTimes' }
);

/** One nearest-station result. */
export const ApiNearestStation = t.Object(
  { station_id: t.String(), distance_km: t.Number() },
  { $id: 'ApiNearestStation' }
);

/** Nearest stations to an arbitrary coordinate. */
export const ApiNearestStations = t.Object(
  {
    network_id: t.String(),
    query: t.Object({ lon: t.Number(), lat: t.Number() }, { $id: 'ApiQueryPoint' }),
    stations: t.Array(t.Ref(ApiNearestStation))
  },
  { $id: 'ApiNearestStations' }
);

/** Liveness probe response. */
export const ApiHealth = t.Object({ status: t.Literal('ok') }, { $id: 'ApiHealth' });

/** Canonical error contract: every non-2xx response body is `{ error: string }`. */
export const ApiError = t.Object({ error: t.String() }, { $id: 'ApiError' });

/**
 * Every named schema, registered with Elysia's `.model()` so the OpenAPI
 * plugin collects them into `components.schemas` and response validators can
 * dereference the `t.Ref(...)` links between them.
 */
export const ApiModels = {
  ApiCrs,
  ApiNames,
  ApiGeoPoint,
  ApiSchematicPoint,
  ApiLineMode,
  ApiLineStatus,
  ApiLine,
  ApiLineList,
  ApiStationStatus,
  ApiStation,
  ApiStationList,
  ApiDirectionType,
  ApiTimetableStatus,
  ApiStop,
  ApiStopList,
  ApiPattern,
  ApiPatternList,
  ApiSegmentDirection,
  ApiTravelTimeSource,
  ApiSegment,
  ApiSegmentList,
  ApiTransfer,
  ApiTransferList,
  ApiTimetable,
  ApiTimetableList,
  ApiStationDetail,
  ApiFareMatrix,
  ApiFareRow,
  ApiCity,
  ApiRoutingDefaults,
  ApiLayerQuality,
  ApiNetworkQuality,
  ApiNetwork,
  ApiNetworkList,
  ApiStopNode,
  ApiStopEdge,
  ApiStopGraph,
  ApiRideLeg,
  ApiTransferLeg,
  ApiRouteLeg,
  ApiRoutePlan,
  ApiTravelTimeEntry,
  ApiTravelTimes,
  ApiNearestStation,
  ApiNearestStations,
  ApiHealth,
  ApiError
} as const;

const SCHEMA_NAMES = new Set(Object.keys(ApiModels));

/**
 * Normalize a generated OpenAPI document so every `$ref` is a resolvable
 * `#/components/schemas/<name>` JSON pointer. TypeBox links schemas by their
 * bare `$id` (`$ref: "ApiLine"`), which most codegen toolchains refuse to
 * resolve — every referenced schema is emitted into `components.schemas` under
 * its `$id`, so the pointers always resolve. Applies in place; `$ref` values
 * that are neither known schema names nor already pointers are treated as a
 * bug and rejected.
 */
export function normalizeOpenApiRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeOpenApiRefs(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
      if (SCHEMA_NAMES.has(value)) {
        (node as Record<string, unknown>)[key] = `#/components/schemas/${value}`;
      } else {
        throw new Error(`unresolvable $ref "${value}" (not a known schema name)`);
      }
    } else {
      normalizeOpenApiRefs(value);
    }
  }
}

export type ApiLine = Static<typeof ApiLine>;
export type ApiLineList = Static<typeof ApiLineList>;
export type ApiStation = Static<typeof ApiStation>;
export type ApiStationList = Static<typeof ApiStationList>;
export type ApiStationDetail = Static<typeof ApiStationDetail>;
export type ApiStop = Static<typeof ApiStop>;
export type ApiStopList = Static<typeof ApiStopList>;
export type ApiPattern = Static<typeof ApiPattern>;
export type ApiPatternList = Static<typeof ApiPatternList>;
export type ApiSegment = Static<typeof ApiSegment>;
export type ApiSegmentList = Static<typeof ApiSegmentList>;
export type ApiTransfer = Static<typeof ApiTransfer>;
export type ApiTransferList = Static<typeof ApiTransferList>;
export type ApiTimetable = Static<typeof ApiTimetable>;
export type ApiTimetableList = Static<typeof ApiTimetableList>;
export type ApiFareMatrix = Static<typeof ApiFareMatrix>;
export type ApiFareRow = Static<typeof ApiFareRow>;
export type ApiNetwork = Static<typeof ApiNetwork>;
export type ApiNetworkList = Static<typeof ApiNetworkList>;
export type ApiStopGraph = Static<typeof ApiStopGraph>;
export type ApiRoutePlan = Static<typeof ApiRoutePlan>;
export type ApiTravelTimes = Static<typeof ApiTravelTimes>;
export type ApiNearestStations = Static<typeof ApiNearestStations>;
export type ApiHealth = Static<typeof ApiHealth>;
export type ApiError = Static<typeof ApiError>;
