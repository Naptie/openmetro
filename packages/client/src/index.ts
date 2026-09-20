import type { Treaty } from '@elysia/eden';
import { treaty } from '@elysia/eden';
// Import the server's own app type from source (not `@openmetro/core`'s built d.ts)
// so tsup can inline it: the published client must not depend on the private
// workspace package.
import type { App } from '../../core/src/api/server.js';

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
 * const { data: stations } = await metro.api.networks({ id: "cn-beijing" }).stations.get();
 * const { data: plan } = await metro.api
 *   .networks({ id: "cn-beijing" })
 *   .route.get({ query: { from: "cn-beijing-pingguoyuan", to: "cn-beijing-xizhimen" } });
 * ```
 */
export const createClient = (baseUrl: string, config?: Treaty.Config): Treaty.Create<App> =>
  treaty<App>(baseUrl, config);

export type Client = ReturnType<typeof createClient>;

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
type SuccessMember<T> = T extends { error?: infer E }
  ? [undefined] extends [E]
    ? Omit<T, 'error'>
    : never
  : T;

/**
 * The success payload of an Eden route method, e.g.
 * `ApiSuccess<Client["api"]["networks"]["get"]>` is `{ networks: ApiNetwork[] }`.
 * Errors (Elysia folds `{ error: string }` bodies into the same union) are
 * stripped, so consumers never have to narrow them away. Exported so third
 * parties can type any route without copying this logic.
 */
export type ApiSuccess<Route> = Route extends (...args: any[]) => Promise<infer Response>
  ? Response extends { data: infer Data }
    ? NonNullable<SuccessMember<Data>>
    : never
  : never;

/**
 * Entity types derived from the client itself — the single source of truth for
 * consumers. Response shapes flow from the Elysia handlers (which read the
 * Effect schemas in @openmetro/core) through Eden's inference, so a schema
 * change here automatically re-types every consumer; nothing is hand-written.
 */
export type ApiNetworksResponse = ApiSuccess<NetworksRoute['get']>;
export type ApiNetwork = NonNullable<ApiNetworksResponse['networks'][number]>;
export type ApiLine = ApiSuccess<NetworkRoute['lines']['get']>[number];
export type ApiStation = ApiSuccess<NetworkRoute['stations']['get']>[number];
export type ApiStop = ApiSuccess<NetworkRoute['stops']['get']>[number];
export type ApiPattern = ApiSuccess<NetworkRoute['patterns']['get']>[number];
export type ApiTimetable = ApiSuccess<NetworkRoute['timetables']['get']>[number];
export type ApiTransfer = ApiSuccess<NetworkRoute['transfers']['get']>[number];
export type ApiStationDetail = ApiSuccess<StationRoute['get']>;
export type ApiRoutePlan = ApiSuccess<NetworkRoute['route']['get']>;

/** The raw mode/status/direction enums, re-derived from the entity shapes. */
export type ApiLineMode = NonNullable<ApiLine['mode']>;
export type ApiLineStatus = NonNullable<ApiLine['status']>;
export type ApiDirectionType = NonNullable<ApiTimetable['direction_type']>;
export type ApiStationRecordStatus = NonNullable<ApiStation['status']>;
