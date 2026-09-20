import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Effect, Either } from 'effect';
import { Elysia, type Static, t } from 'elysia';
import type { NetworkSource } from '../data/source.js';
import type { NetworkData } from '../data/types.js';
import { buildStationIndex, buildStopGraph, type WeightKind } from '../graph/build.js';
import { travelTimes } from '../graph/dijkstra.js';
import { planRoute } from '../graph/route.js';
import { buildSpatialIndex, type SpatialIndex } from '../graph/spatial.js';
import type { FareMatrixEncoded, StationEncoded } from '../schema/index.js';
import { statusForRecord } from '../timetable/status.js';
import { enrichRoutePlan } from './headsigns.js';
import {
  projectFareMatrix,
  projectLine,
  projectNetwork,
  projectPattern,
  projectSegment,
  projectStation,
  projectStop,
  projectTimetable,
  projectTransfer
} from './projections.js';
import {
  ApiError,
  ApiFareMatrix,
  ApiFareRow,
  ApiHealth,
  ApiLineList,
  ApiModels,
  ApiNearestStations,
  ApiNetwork,
  ApiNetworkList,
  ApiPatternList,
  ApiRoutePlan,
  ApiSegmentList,
  ApiStationDetail,
  ApiStationList,
  ApiStopGraph,
  ApiStopList,
  ApiTimetableList,
  ApiTransferList,
  ApiTravelTimes
} from './schema.js';

/** Run an Effect and resolve to a value (throws on failure → Elysia error). */
function runEffect<E, A>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/** station id -> the line ids that call there (derived from stops). */
function stationLines(data: NetworkData): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const stop of data.stops) {
    const lines = map.get(stop.station_id) ?? [];
    if (!lines.includes(stop.line_id)) lines.push(stop.line_id);
    map.set(stop.station_id, lines);
  }
  return map;
}

function projectStations(data: NetworkData) {
  const lines = stationLines(data);
  return data.stations.map((s) => {
    const stationLineIds = lines.get(s.id) ?? [];
    return projectStation(s, stationLineIds, stationLineIds.length > 1);
  });
}

function resolveWeight(weight: 'time' | 'distance' | undefined, data: NetworkData): WeightKind {
  if (weight === 'distance') return 'distance';
  if (weight === 'time') return 'time';
  return data.network.routing.weight;
}

/** Fare for one origin/destination pair from the network's matrix. */
function lookupFare(matrix: FareMatrixEncoded, from: string, to: string): number | null {
  const i = matrix.station_ids.indexOf(from);
  const j = matrix.station_ids.indexOf(to);
  if (i < 0 || j < 0) return null;
  return matrix.fares[i]?.[j] ?? null;
}

const NetworkParams = t.Object({
  id: t.String({
    description: 'Network id',
    examples: ['cn-beijing', 'cn-shanghai', 'cn-guangzhou']
  })
});

const StationParams = t.Object({
  id: t.String({ description: 'Network id', examples: ['cn-beijing'] }),
  stationId: t.String({ description: 'Station id', examples: ['cn-beijing-xizhimen'] })
});

const WeightQuery = t.Optional(
  t.Union([t.Literal('time'), t.Literal('distance')], {
    description: "Routing weight; defaults to the network's `routing.weight`."
  })
);

const TAGS = [
  { name: 'Health', description: 'Liveness probe' },
  { name: 'Networks', description: 'Network metadata and city information' },
  { name: 'Lines', description: 'Line metadata (names, colours, mode)' },
  { name: 'Stations', description: 'Station identity, coordinates and line membership' },
  { name: 'Stops', description: 'Per-line stop occurrences (routing nodes)' },
  { name: 'Patterns', description: 'Route alignments (main + branches)' },
  { name: 'Segments', description: 'Ride edges with travel times' },
  { name: 'Transfers', description: 'Directional transfer walk edges' },
  { name: 'Timetables', description: 'First/last train times and in-service status' },
  { name: 'Fares', description: 'Origin/destination fares (optional layer)' },
  { name: 'Routing', description: 'Derived graphs, routes and travel-time isochrones' }
];

export interface ApiAppOptions {
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
export function createApiApp(source: NetworkSource, options: ApiAppOptions = {}) {
  /**
   * Load one network and run `fn` over it. Unknown network ids are a client
   * error (404), not a crash: `source.load` fails and the handler returns
   * `ApiError` instead of letting the failure bubble into an unhandled 500.
   */
  const withNetwork = async <A>(
    id: string,
    fn: (data: NetworkData) => A,
    set: { status?: number | string | undefined }
  ): Promise<A | ApiError> => {
    const result = await runEffect(source.load(id).pipe(Effect.either));
    if (Either.isLeft(result)) {
      set.status = 404;
      return { error: `unknown network ${id}` };
    }
    return fn(result.right);
  };

  // Spatial indices are built lazily per network (only `/nearest` needs them).
  // Eagerly decoding every network on app creation burned hundreds of ms of
  // CPU on the first request of each Workers isolate — including for cheap
  // routes like `/api/health` and `/api/networks/:id/lines`.
  const spatialIndices = new Map<string, SpatialIndex<StationEncoded>>();

  async function getSpatialIndex(id: string): Promise<SpatialIndex<StationEncoded> | undefined> {
    const cached = spatialIndices.get(id);
    if (cached) return cached;
    const result = await runEffect(source.load(id).pipe(Effect.either));
    if (Either.isLeft(result)) return undefined;
    const withLocation = result.right.stations.filter(
      (s): s is StationEncoded & { location: { lon: number; lat: number } } => s.location != null
    );
    const index = buildSpatialIndex(withLocation, (s) => s.location);
    spatialIndices.set(id, index);
    return index;
  }

  return (
    new Elysia({ aot: options.aot ?? true })
      // Named wire schemas: registered as models so the OpenAPI plugin emits
      // them into `components.schemas` and response validators can resolve
      // the `t.Ref` links between them.
      .model(ApiModels)
      // Public read-only API: unrestricted CORS so any site can call it.
      // No credentials; methods stay GET/OPTIONS.
      .use(
        cors({
          origin: true,
          methods: ['GET', 'OPTIONS'],
          allowedHeaders: ['Content-Type'],
          maxAge: 86_400
        })
      )
      // OpenAPI docs. `@elysiajs/openapi` builds a fresh UI response per
      // request on Cloudflare Workers, so no manual response handling is needed.
      .use(
        openapi({
          path: '/swagger',
          documentation: {
            info: {
              title: 'Open Metro API',
              version: '0.1.0',
              description:
                'Read-only API over canonical metro network data (lines, stations, stops, ' +
                'patterns, segments, transfers, timetables). Travel time is the canonical ' +
                'routing weight; routing runs on the stop graph so line changes are charged ' +
                'as transfer edges.'
            },
            servers: [
              {
                url: 'https://openmetro.phi.zone',
                description: 'Production (Cloudflare Worker)'
              },
              { url: 'http://localhost:8790', description: 'Local development' }
            ],
            tags: TAGS
          }
        })
      )
      .get('/api/health', () => ({ status: 'ok' }) as const, {
        detail: { tags: ['Health'], summary: 'Liveness probe' },
        response: { 200: ApiHealth }
      })
      .get(
        '/api/networks',
        async () => {
          const ids = await source.list();
          const networks = await Promise.all(
            ids.map((id) =>
              runEffect(source.loadMeta(id).pipe(Effect.map(projectNetwork))).catch(() => null)
            )
          );
          return { networks: networks.filter((n) => n != null) };
        },
        {
          detail: { tags: ['Networks'], summary: 'List all networks with metadata' },
          response: { 200: ApiNetworkList }
        }
      )
      .get(
        '/api/networks/:id',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiNetwork>>(
            params.id,
            (d) => projectNetwork(d.network, d.generated_at),
            set
          ),
        {
          params: NetworkParams,
          detail: { tags: ['Networks'], summary: "Get one network's metadata" },
          response: { 200: ApiNetwork, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/lines',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiLineList>>(params.id, (d) => d.lines.map(projectLine), set),
        {
          params: NetworkParams,
          detail: { tags: ['Lines'], summary: 'List lines' },
          response: { 200: ApiLineList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/stations',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiStationList>>(params.id, projectStations, set),
        {
          params: NetworkParams,
          detail: {
            tags: ['Stations'],
            summary: 'List stations with coordinates, lines and interchange status'
          },
          response: { 200: ApiStationList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/stations/:stationId',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiStationDetail> | ApiError>(
            params.id,
            (d) => {
              const lines = stationLines(d);
              const station = d.stations.find((s) => s.id === params.stationId);
              if (!station) {
                set.status = 404;
                return { error: `unknown station ${params.stationId}` };
              }
              const lineIds = lines.get(station.id) ?? [];
              const stationTimetables = d.timetables.filter((t) => t.station_id === station.id);
              const now = new Date();
              return {
                ...projectStation(station, lineIds, lineIds.length > 1),
                transfers: d.transfers
                  .filter((t) => t.station_id === station.id)
                  .map(projectTransfer),
                timetables: stationTimetables.map(projectTimetable),
                status: stationTimetables.map((t) => statusForRecord(t, now, d.network.timezone))
              };
            },
            set
          ),
        {
          params: StationParams,
          detail: {
            tags: ['Stations'],
            summary: 'Station detail with transfers, timetables and in-service status'
          },
          response: { 200: ApiStationDetail, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/stops',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiStopList>>(params.id, (d) => d.stops.map(projectStop), set),
        {
          params: NetworkParams,
          detail: { tags: ['Stops'], summary: 'List per-line stops' },
          response: { 200: ApiStopList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/patterns',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiPatternList>>(
            params.id,
            (d) => d.patterns.map(projectPattern),
            set
          ),
        {
          params: NetworkParams,
          detail: { tags: ['Patterns'], summary: 'List route alignments (main + branches)' },
          response: { 200: ApiPatternList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/segments',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiSegmentList>>(
            params.id,
            (d) => d.segments.map(projectSegment),
            set
          ),
        {
          params: NetworkParams,
          detail: { tags: ['Segments'], summary: 'List ride edges' },
          response: { 200: ApiSegmentList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/transfers',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiTransferList>>(
            params.id,
            (d) => d.transfers.map(projectTransfer),
            set
          ),
        {
          params: NetworkParams,
          detail: { tags: ['Transfers'], summary: 'List directional transfer walk edges' },
          response: { 200: ApiTransferList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/timetables',
        ({ params, set }) =>
          withNetwork<Static<typeof ApiTimetableList>>(
            params.id,
            (d) => d.timetables.map(projectTimetable),
            set
          ),
        {
          params: NetworkParams,
          detail: { tags: ['Timetables'], summary: 'List timetables' },
          response: { 200: ApiTimetableList, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/fares',
        ({ params, query, set }) =>
          withNetwork<Static<typeof ApiFareMatrix> | Static<typeof ApiFareRow> | ApiError>(
            params.id,
            (d) => {
              const matrix = d.fares;
              if (!matrix) {
                set.status = 404;
                return { error: 'no fares published for this network' };
              }
              const from = query.from;
              if (from) {
                const i = matrix.station_ids.indexOf(from);
                if (i < 0) {
                  set.status = 404;
                  return { error: `unknown station ${from}` };
                }
                const row = matrix.fares[i] ?? [];
                const fares: Record<string, number | null> = {};
                matrix.station_ids.forEach((to, j) => {
                  fares[to] = row[j] ?? null;
                });
                return {
                  from_station_id: from,
                  currency: matrix.currency,
                  unit: matrix.unit,
                  fares
                };
              }
              return projectFareMatrix(matrix);
            },
            set
          ),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.Optional(
              t.String({
                description: "Return only this origin station's fare row.",
                examples: ['cn-beijing-pingguoyuan']
              })
            )
          }),
          detail: {
            tags: ['Fares'],
            summary: "Origin-destination fare matrix (or one origin's row)"
          },
          response: {
            200: t.Union([t.Ref(ApiFareMatrix), t.Ref(ApiFareRow)]),
            404: ApiError
          }
        }
      )
      .get(
        '/api/networks/:id/graph',
        ({ params, query, set }) =>
          withNetwork<Static<typeof ApiStopGraph>>(
            params.id,
            (d) => {
              const filter = {
                stations: d.stations,
                lines: d.lines,
                includeNonOperating: query.include_non_operating === true
              };
              const graph = buildStopGraph(
                d.network.id,
                d.stops,
                d.segments,
                d.transfers,
                d.network.routing,
                resolveWeight(query.weight, d),
                filter
              );
              return {
                network_id: d.network.id,
                weight: graph.kind === 'time' ? 'seconds' : 'km',
                routing: d.network.routing,
                nodes: graph.nodes,
                edges: graph.edges
              };
            },
            set
          ),
        {
          params: NetworkParams,
          query: t.Object({
            weight: WeightQuery,
            include_non_operating: t.Optional(t.Boolean())
          }),
          detail: {
            tags: ['Routing'],
            summary: 'Assembled stop graph (nodes + weighted ride/transfer edges)'
          },
          response: { 200: ApiStopGraph, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/route',
        ({ params, query, set }) =>
          withNetwork<Static<typeof ApiRoutePlan> | ApiError>(
            params.id,
            (d) => {
              const { from, to } = query;
              const filter = {
                stations: d.stations,
                lines: d.lines,
                includeNonOperating: false
              };
              const index = buildStationIndex(d.stops, filter);
              if (!index.has(from) || !index.has(to)) {
                set.status = 404;
                return {
                  error: `unknown or non-operating station ${!index.has(from) ? from : to}`
                };
              }
              const graph = buildStopGraph(
                d.network.id,
                d.stops,
                d.segments,
                d.transfers,
                d.network.routing,
                resolveWeight(query.weight, d),
                filter
              );
              const plan = planRoute(graph, d.stops, from, to, index);
              if (!plan) {
                set.status = 404;
                return { error: 'no route found' };
              }
              const enriched = enrichRoutePlan(d, plan);
              return {
                ...enriched,
                fare: d.fares ? lookupFare(d.fares, from, to) : null,
                currency: d.fares?.currency ?? null
              };
            },
            set
          ),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.String({
              description: 'Origin station id',
              examples: ['cn-beijing-pingguoyuan']
            }),
            to: t.String({
              description: 'Destination station id',
              examples: ['cn-beijing-xizhimen']
            }),
            weight: WeightQuery
          }),
          detail: {
            tags: ['Routing'],
            summary: 'Station-to-station route with legs, total time and transfer count'
          },
          response: { 200: ApiRoutePlan, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/travel-times',
        ({ params, query, set }) =>
          withNetwork<Static<typeof ApiTravelTimes> | ApiError>(
            params.id,
            (d) => {
              const { from } = query;
              const filter = {
                stations: d.stations,
                lines: d.lines,
                includeNonOperating: false
              };
              const index = buildStationIndex(d.stops, filter);
              const sources = index.get(from);
              if (!sources || sources.length === 0) {
                set.status = 404;
                return { error: `unknown or non-operating station ${from}` };
              }
              const graph = buildStopGraph(
                d.network.id,
                d.stops,
                d.segments,
                d.transfers,
                d.network.routing,
                resolveWeight(query.weight, d),
                filter
              );
              const stationByStop = new Map(d.stops.map((s) => [s.id, s.station_id]));
              const stopTimes = travelTimes(graph, sources);
              const stationTimes = new Map<string, number>();
              for (const [stopId, seconds] of stopTimes) {
                const stationId = stationByStop.get(stopId);
                if (!stationId) continue;
                const current = stationTimes.get(stationId);
                if (current == null || seconds < current) stationTimes.set(stationId, seconds);
              }
              const within = query.within;
              const stations = [...stationTimes.entries()]
                .filter(
                  ([, seconds]) => within == null || !Number.isFinite(within) || seconds <= within
                )
                .map(([station_id, seconds]) => ({ station_id, seconds }))
                .sort((a, b) => a.seconds - b.seconds);
              return {
                from_station_id: from,
                weight: graph.kind === 'time' ? 'seconds' : 'km',
                within: within != null && Number.isFinite(within) ? within : null,
                stations
              };
            },
            set
          ),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.String({
              description: 'Origin station id',
              examples: ['cn-beijing-pingguoyuan']
            }),
            within: t.Optional(
              t.Numeric({
                description: 'Only return stations reachable within this many seconds.',
                examples: [600]
              })
            ),
            weight: WeightQuery
          }),
          detail: {
            tags: ['Routing'],
            summary: 'Travel-time isochrone from one station to every other station'
          },
          response: { 200: ApiTravelTimes, 404: ApiError }
        }
      )
      .get(
        '/api/networks/:id/nearest',
        async ({ params, query, set }) => {
          const index = await getSpatialIndex(params.id);
          if (!index) {
            set.status = 404;
            return { error: `unknown network ${params.id}` };
          }
          const results = index.nearest({ lon: query.lon, lat: query.lat }, query.k ?? 5);
          return {
            network_id: params.id,
            query: { lon: query.lon, lat: query.lat },
            stations: results.map((r: { item: StationEncoded; distance: number }) => ({
              station_id: r.item.id,
              distance_km: Math.round(r.distance * 1000) / 1000
            }))
          };
        },
        {
          params: NetworkParams,
          query: t.Object({
            lon: t.Number({ description: 'Longitude (WGS-84 / GCJ-02)', examples: [121.475] }),
            lat: t.Number({ description: 'Latitude (WGS-84 / GCJ-02)', examples: [31.233] }),
            k: t.Optional(
              t.Number({
                description: 'Number of nearest stations to return (default 5).',
                examples: [5]
              })
            )
          }),
          detail: {
            tags: ['Stations'],
            summary: 'Find nearest stations to an arbitrary coordinate'
          },
          response: { 200: ApiNearestStations, 404: ApiError }
        }
      )
  );
}

export type App = ReturnType<typeof createApiApp>;
