import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Effect } from 'effect';
import { Elysia, t } from 'elysia';
import type { NetworkSource } from '../data/source.js';
import type { NetworkData } from '../data/types.js';
import { buildStationIndex, buildStopGraph, type WeightKind } from '../graph/build.js';
import { travelTimes } from '../graph/dijkstra.js';
import { planRoute } from '../graph/route.js';
import { buildSpatialIndex, type SpatialIndex } from '../graph/spatial.js';
import type { FareMatrixEncoded, StationEncoded } from '../schema/index.js';
import { statusForRecord } from '../timetable/status.js';
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
  id: t.String({ description: 'Network id', examples: ['cn-bj', 'cn-sh', 'cn-gz'] })
});

const StationParams = t.Object({
  id: t.String({ description: 'Network id', examples: ['cn-bj'] }),
  stationId: t.String({ description: 'Station id', examples: ['cn-bj-xizhimen'] })
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
  const withNetwork = <A>(id: string, fn: (data: NetworkData) => A) =>
    runEffect(source.load(id).pipe(Effect.map(fn)));

  // Pre-build spatial indices for all networks at startup so queries are
  // instant. On the Node/Bun server this runs at module load; on Cloudflare
  // Workers it runs once per isolate on first request (then persists).
  const spatialIndices: Promise<Map<string, SpatialIndex<StationEncoded>>> = runEffect(
    Effect.tryPromise(() => source.list()).pipe(
      Effect.flatMap((ids) =>
        Effect.all(
          ids.map((id) =>
            source.load(id).pipe(
              Effect.map((d) => {
                const withLocation = d.stations.filter(
                  (s): s is StationEncoded & { location: { lon: number; lat: number } } =>
                    s.location != null
                );
                return [id, buildSpatialIndex(withLocation, (s) => s.location)] as const;
              })
            )
          )
        )
      ),
      Effect.map((entries) => new Map<string, SpatialIndex<StationEncoded>>(entries))
    )
  );

  return (
    new Elysia({ aot: options.aot ?? true })
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
      .get('/api/health', () => ({ status: 'ok' }), {
        detail: { tags: ['Health'], summary: 'Liveness probe' }
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
        { detail: { tags: ['Networks'], summary: 'List all networks with metadata' } }
      )
      .get(
        '/api/networks/:id',
        ({ params }) => withNetwork(params.id, (d) => projectNetwork(d.network)),
        {
          params: NetworkParams,
          detail: { tags: ['Networks'], summary: "Get one network's metadata" }
        }
      )
      .get(
        '/api/networks/:id/lines',
        ({ params }) => withNetwork(params.id, (d) => d.lines.map(projectLine)),
        { params: NetworkParams, detail: { tags: ['Lines'], summary: 'List lines' } }
      )
      .get('/api/networks/:id/stations', ({ params }) => withNetwork(params.id, projectStations), {
        params: NetworkParams,
        detail: {
          tags: ['Stations'],
          summary: 'List stations with coordinates, lines and interchange status'
        }
      })
      .get(
        '/api/networks/:id/stations/:stationId',
        ({ params, set }) =>
          withNetwork(params.id, (d) => {
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
          }),
        {
          params: StationParams,
          detail: {
            tags: ['Stations'],
            summary: 'Station detail with transfers, timetables and in-service status'
          }
        }
      )
      .get(
        '/api/networks/:id/stops',
        ({ params }) => withNetwork(params.id, (d) => d.stops.map(projectStop)),
        { params: NetworkParams, detail: { tags: ['Stops'], summary: 'List per-line stops' } }
      )
      .get(
        '/api/networks/:id/patterns',
        ({ params }) => withNetwork(params.id, (d) => d.patterns.map(projectPattern)),
        {
          params: NetworkParams,
          detail: { tags: ['Patterns'], summary: 'List route alignments (main + branches)' }
        }
      )
      .get(
        '/api/networks/:id/segments',
        ({ params }) => withNetwork(params.id, (d) => d.segments.map(projectSegment)),
        { params: NetworkParams, detail: { tags: ['Segments'], summary: 'List ride edges' } }
      )
      .get(
        '/api/networks/:id/transfers',
        ({ params }) => withNetwork(params.id, (d) => d.transfers.map(projectTransfer)),
        {
          params: NetworkParams,
          detail: { tags: ['Transfers'], summary: 'List directional transfer walk edges' }
        }
      )
      .get(
        '/api/networks/:id/timetables',
        ({ params }) => withNetwork(params.id, (d) => d.timetables.map(projectTimetable)),
        { params: NetworkParams, detail: { tags: ['Timetables'], summary: 'List timetables' } }
      )
      .get(
        '/api/networks/:id/fares',
        ({ params, query, set }) =>
          withNetwork(params.id, (d) => {
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
          }),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.Optional(
              t.String({
                description: "Return only this origin station's fare row.",
                examples: ['cn-bj-pingguoyuan']
              })
            )
          }),
          detail: {
            tags: ['Fares'],
            summary: "Origin-destination fare matrix (or one origin's row)"
          }
        }
      )
      .get(
        '/api/networks/:id/graph',
        ({ params, query }) =>
          withNetwork(params.id, (d) => {
            const graph = buildStopGraph(
              d.network.id,
              d.stops,
              d.segments,
              d.transfers,
              d.network.routing,
              resolveWeight(query.weight, d)
            );
            return {
              network_id: d.network.id,
              weight: graph.kind === 'time' ? 'seconds' : 'km',
              routing: d.network.routing,
              nodes: graph.nodes,
              edges: graph.edges
            };
          }),
        {
          params: NetworkParams,
          query: t.Object({ weight: WeightQuery }),
          detail: {
            tags: ['Routing'],
            summary: 'Assembled stop graph (nodes + weighted ride/transfer edges)'
          }
        }
      )
      .get(
        '/api/networks/:id/route',
        ({ params, query, set }) =>
          withNetwork(params.id, (d) => {
            const { from, to } = query;
            const index = buildStationIndex(d.stops);
            if (!index.has(from) || !index.has(to)) {
              set.status = 404;
              return { error: `unknown station ${!index.has(from) ? from : to}` };
            }
            const graph = buildStopGraph(
              d.network.id,
              d.stops,
              d.segments,
              d.transfers,
              d.network.routing,
              resolveWeight(query.weight, d)
            );
            const plan = planRoute(graph, d.stops, from, to, index);
            if (!plan) {
              set.status = 404;
              return { error: 'no route found' };
            }
            return {
              ...plan,
              fare: d.fares ? lookupFare(d.fares, from, to) : null,
              currency: d.fares?.currency ?? null
            };
          }),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.String({ description: 'Origin station id', examples: ['cn-bj-pingguoyuan'] }),
            to: t.String({ description: 'Destination station id', examples: ['cn-bj-xizhimen'] }),
            weight: WeightQuery
          }),
          detail: {
            tags: ['Routing'],
            summary: 'Station-to-station route with legs, total time and transfer count'
          }
        }
      )
      .get(
        '/api/networks/:id/travel-times',
        ({ params, query, set }) =>
          withNetwork(params.id, (d) => {
            const { from } = query;
            const index = buildStationIndex(d.stops);
            const sources = index.get(from);
            if (!sources || sources.length === 0) {
              set.status = 404;
              return { error: `unknown station ${from}` };
            }
            const graph = buildStopGraph(
              d.network.id,
              d.stops,
              d.segments,
              d.transfers,
              d.network.routing,
              resolveWeight(query.weight, d)
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
          }),
        {
          params: NetworkParams,
          query: t.Object({
            from: t.String({ description: 'Origin station id', examples: ['cn-bj-pingguoyuan'] }),
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
          }
        }
      )
      .get(
        '/api/networks/:id/nearest',
        async ({ params, query, set }) => {
          const indices = await spatialIndices;
          const index = indices.get(params.id);
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
          }
        }
      )
  );
}

export type App = ReturnType<typeof createApiApp>;
