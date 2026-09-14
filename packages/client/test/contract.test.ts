/**
 * Contract test: live server responses must satisfy the generated zod schemas
 * shipped in `openmetro-client/schemas`.
 *
 * Both sides derive from the same single source — the wire schemas in
 * `packages/core/src/api/schema.ts` — so this is the end-to-end proof that the
 * running server, the OpenAPI document and the published client agree: Elysia
 * validates responses against the TypeBox shapes, and these tests validate the
 * same bytes against the zod shapes generated from them.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApiApp } from '../../core/src/api/app.js';
import { createFsNetworkSource } from '../../core/src/data/fs.js';
import { apiSchemas } from '../src/schemas.generated.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, '../../../data');

const app = createApiApp(createFsNetworkSource(dataRoot));

/** Route path -> wire schema name whose schema must accept the 200 response. */
const ROUTES: Array<[string, string]> = [
  ['/api/health', 'ApiHealth'],
  ['/api/networks', 'ApiNetworkList'],
  ['/api/networks/cn-bj', 'ApiNetwork'],
  ['/api/networks/cn-gz/lines', 'ApiLineList'],
  ['/api/networks/cn-bj/stations', 'ApiStationList'],
  ['/api/networks/cn-bj/stations/cn-bj-xizhimen', 'ApiStationDetail'],
  ['/api/networks/cn-bj/stops', 'ApiStopList'],
  ['/api/networks/cn-bj/patterns', 'ApiPatternList'],
  ['/api/networks/cn-bj/segments', 'ApiSegmentList'],
  ['/api/networks/cn-bj/transfers', 'ApiTransferList'],
  ['/api/networks/cn-bj/timetables', 'ApiTimetableList'],
  ['/api/networks/cn-bj/fares', 'ApiFareMatrix'],
  ['/api/networks/cn-bj/fares?from=cn-bj-pingguoyuan', 'ApiFareRow'],
  ['/api/networks/cn-bj/graph', 'ApiStopGraph'],
  ['/api/networks/cn-bj/route?from=cn-bj-pingguoyuan&to=cn-bj-xizhimen', 'ApiRoutePlan'],
  ['/api/networks/cn-bj/travel-times?from=cn-bj-pingguoyuan&within=600', 'ApiTravelTimes'],
  ['/api/networks/cn-bj/nearest?lon=116.4&lat=39.9', 'ApiNearestStations']
];

test('every route response validates against its generated zod schema', {
  timeout: 30_000
}, async () => {
  for (const [path, schemaName] of ROUTES) {
    const schema = apiSchemas[schemaName as keyof typeof apiSchemas];
    assert.ok(schema, `no generated schema for ${schemaName}`);

    const res = await app.handle(new Request(`http://localhost${path}`));
    assert.equal(res.status, 200, `${path} expected 200`);
    const body = await res.json();

    const parsed = (schema as { safeParse: (v: unknown) => unknown }).safeParse(body);
    assert.ok(
      isSuccess(parsed),
      `${path} (${schemaName}) failed zod validation: ${formatIssues(parsed)}`
    );
  }
});

test('route-plan legs are discriminated on kind and match the wire', {
  timeout: 30_000
}, async () => {
  const res = await app.handle(
    new Request(
      'http://localhost/api/networks/cn-bj/route?from=cn-bj-pingguoyuan&to=cn-bj-xizhimen'
    )
  );
  assert.equal(res.status, 200);
  const plan = (await res.json()) as {
    legs: Array<{ kind: 'ride' | 'transfer'; line_id?: string; station_ids?: string[] }>;
  };
  assert.ok(plan.legs.length >= 1);
  for (const leg of plan.legs) {
    assert.ok(leg.kind === 'ride' || leg.kind === 'transfer');
    if (leg.kind === 'ride') assert.ok(Array.isArray(leg.station_ids));
    if (leg.kind === 'transfer') assert.ok(leg.station_ids === undefined);
  }
});

test('error responses validate against ApiError', { timeout: 30_000 }, async () => {
  const res = await app.handle(new Request('http://localhost/api/networks/zzz/lines'));
  assert.equal(res.status, 404);
  const body = await res.json();
  const parsed = apiSchemas.ApiError.safeParse(body);
  assert.ok(isSuccess(parsed), `404 body failed ApiError validation: ${formatIssues(parsed)}`);
});

function isSuccess(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success: boolean }).success === true
  );
}

function formatIssues(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('error' in result)) return 'unknown error';
  const error = (result as { error: unknown }).error;
  return JSON.stringify(error).slice(0, 300);
}
