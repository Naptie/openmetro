import type { Treaty } from "@elysia/eden";
import { treaty } from "@elysia/eden";
// Import the server's own app type from source (not `@openmetro/core`'s built d.ts)
// so tsup can inline it: the published client must not depend on the private
// workspace package.
import type { App } from "../../core/src/api/server.js";

export type { App };

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
export const createClient = (baseUrl: string, config?: Treaty.Config): Treaty.Create<App> =>
  treaty<App>(baseUrl, config);

export type Client = ReturnType<typeof createClient>;
