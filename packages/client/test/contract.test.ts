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
  ['/api/networks/cn-beijing', 'ApiNetwork'],
  ['/api/networks/cn-guangzhou/lines', 'ApiLineList'],
  ['/api/networks/cn-beijing/stations', 'ApiStationList'],
  ['/api/networks/cn-beijing/stations/cn-beijing-xizhimen', 'ApiStationDetail'],
  ['/api/networks/cn-beijing/stops', 'ApiStopList'],
  ['/api/networks/cn-beijing/patterns', 'ApiPatternList'],
  ['/api/networks/cn-beijing/segments', 'ApiSegmentList'],
  ['/api/networks/cn-beijing/transfers', 'ApiTransferList'],
  ['/api/networks/cn-beijing/timetables', 'ApiTimetableList'],
  ['/api/networks/cn-beijing/fares', 'ApiFareMatrix'],
  ['/api/networks/cn-beijing/fares?from=cn-beijing-pingguoyuan', 'ApiFareRow'],
  ['/api/networks/cn-beijing/graph', 'ApiStopGraph'],
  [
    '/api/networks/cn-beijing/route?from=cn-beijing-pingguoyuan&to=cn-beijing-xizhimen',
    'ApiRoutePlan'
  ],
  [
    '/api/networks/cn-beijing/travel-times?from=cn-beijing-pingguoyuan&within=600',
    'ApiTravelTimes'
  ],
  ['/api/networks/cn-beijing/nearest?lon=116.4&lat=39.9', 'ApiNearestStations']
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
      'http://localhost/api/networks/cn-beijing/route?from=cn-beijing-pingguoyuan&to=cn-beijing-xizhimen'
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
