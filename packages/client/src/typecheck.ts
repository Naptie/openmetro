/**
 * Compile-time proof that the generated Eden client mirrors the server routes.
 * Not imported by `index.ts`, so it never ships in the published package.
 *
 * The assignability assertions pin the entity shapes Eden infers from the
 * server's response schemas: if a server-side schema change silently reshapes
 * a documented field, one of these lines stops compiling.
 */
import {
  type ApiLine,
  type ApiLineMode,
  type ApiRoutePlan,
  type ApiStation,
  createClient
} from './index.js';

const client = createClient('http://127.0.0.1:8790');

// --- Shape-pinning assertions ---------------------------------------------
// Enums are exhaustive string literal unions.
const metro: ApiLineMode = 'metro';
const airportExpress: ApiLineMode = 'airport_express';
const operating: ApiLine['status'] = 'operating';
const closed: ApiLine['status'] = 'closed';
// `short_name` is mandatory and not guaranteed ASCII/numeric.
const badge: ApiLine['short_name'] = 'APM';
const numericBadge: ApiLine['short_name'] = '1';
// Optional display fields stay read-as-`string | undefined`.
const maybeColor: ApiLine['color'] = undefined;
const red: ApiLine['color'] = '#c23a30';
const maybeTextColor: ApiLine['text_color'] = undefined;
const names: ApiLine['names'] = { zh: '地铁', en: 'Metro' };
const interchange: ApiStation['is_interchange'] = true;
// Route-plan legs are a discriminated union on `kind`.
const rideLeg: Extract<ApiRoutePlan['legs'][number], { kind: 'ride' }> = {
  kind: 'ride',
  line_id: 'cn-bj-line-1',
  from_stop_id: 'a',
  to_stop_id: 'b',
  from_station_id: 'x',
  to_station_id: 'y',
  seconds: 120,
  station_ids: ['x', 'y']
};
const transferLeg: Extract<ApiRoutePlan['legs'][number], { kind: 'transfer' }> = {
  kind: 'transfer',
  from_stop_id: 'a',
  to_stop_id: 'b',
  from_station_id: 'x',
  to_station_id: 'y',
  seconds: 90
};
const totalSeconds: ApiRoutePlan['total_seconds'] = 300;
const fare: ApiRoutePlan['fare'] = 5;
const noFare: ApiRoutePlan['fare'] = null;

async function main() {
  const networks = await client.api.networks.get();
  const network = await client.api.networks({ id: 'cn-bj' }).get();
  const stations = await client.api.networks({ id: 'cn-bj' }).stations.get();
  const station = await client.api
    .networks({ id: 'cn-bj' })
    .stations({ stationId: 'cn-bj-xizhimen' })
    .get();
  const graph = await client.api.networks({ id: 'cn-bj' }).graph.get({
    query: { weight: 'time' }
  });
  const plan = await client.api.networks({ id: 'cn-bj' }).route.get({
    query: { from: 'cn-bj-pingguoyuan', to: 'cn-bj-xizhimen' }
  });
  const isochrone = await client.api.networks({ id: 'cn-bj' })['travel-times'].get({
    query: { from: 'cn-bj-pingguoyuan', within: 600 }
  });
  const fares = await client.api.networks({ id: 'cn-bj' }).fares.get();
  const fareRow = await client.api.networks({ id: 'cn-bj' }).fares.get({
    query: { from: 'cn-bj-pingguoyuan' }
  });
  return {
    networks,
    network,
    stations,
    station,
    graph,
    plan,
    isochrone,
    fares,
    fareRow,
    metro,
    airportExpress,
    operating,
    closed,
    badge,
    numericBadge,
    maybeColor,
    red,
    maybeTextColor,
    names,
    interchange,
    rideLeg,
    transferLeg,
    totalSeconds,
    fare,
    noFare
  };
}

void main;
