/**
 * Compile-time proof that the generated Eden client mirrors the server routes.
 * Not imported by `index.ts`, so it never ships in the published package.
 */
import { createClient } from "./index.js";

const client = createClient("http://127.0.0.1:8790");

async function main() {
  const networks = await client.api.networks.get();
  const network = await client.api.networks({ id: "cn-bj" }).get();
  const stations = await client.api.networks({ id: "cn-bj" }).stations.get();
  const station = await client.api
    .networks({ id: "cn-bj" })
    .stations({ stationId: "cn-bj-xizhimen" })
    .get();
  const graph = await client.api.networks({ id: "cn-bj" }).graph.get({
    query: { weight: "time" },
  });
  const plan = await client.api.networks({ id: "cn-bj" }).route.get({
    query: { from: "cn-bj-pingguoyuan", to: "cn-bj-xizhimen" },
  });
  const isochrone = await client.api.networks({ id: "cn-bj" })["travel-times"].get({
    query: { from: "cn-bj-pingguoyuan", within: 600 },
  });
  const fares = await client.api.networks({ id: "cn-bj" }).fares.get();
  const fareRow = await client.api.networks({ id: "cn-bj" }).fares.get({
    query: { from: "cn-bj-pingguoyuan" },
  });
  return { networks, network, stations, station, graph, plan, isochrone, fares, fareRow };
}

void main;
