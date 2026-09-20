import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApiApp } from '../src/api/app.js';
import { ApiModels, normalizeOpenApiRefs } from '../src/api/schema.js';
import { createFsNetworkSource } from '../src/data/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, '../../../data');

const app = createApiApp(createFsNetworkSource(dataRoot));

type Json = Record<string, unknown>;

async function swaggerJson(): Promise<Json> {
  const res = await app.handle(new Request('http://localhost/swagger/json'));
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Json;
  // Same normalization the export script applies: bare `$ref: "ApiX"` values
  // become `#/components/schemas/ApiX` pointers.
  normalizeOpenApiRefs(doc);
  return doc;
}

test('openapi.json has every named wire schema in components.schemas', async () => {
  const doc = await swaggerJson();
  const schemas = (doc.components as Json | undefined)?.schemas as Json | undefined;
  assert.ok(schemas, 'components.schemas missing');
  for (const name of Object.keys(ApiModels)) {
    assert.ok(name in schemas, `components.schemas missing "${name}"`);
  }
});

test('openapi.json documents a 200 response schema for every operation', async () => {
  const doc = await swaggerJson();
  const paths = (doc.paths as Json | undefined) ?? {};
  assert.ok(Object.keys(paths).length > 0, 'no paths documented');
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item as Json)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const responses = (op as Json).responses as Json | undefined;
      const content = (responses?.['200'] as Json | undefined)?.content as Json | undefined;
      const schema = (content?.['application/json'] as Json | undefined)?.schema;
      assert.ok(schema, `${method.toUpperCase()} ${path} has no 200 response schema`);
    }
  }
});

test('openapi.json refs all resolve inside components.schemas', async () => {
  const doc = await swaggerJson();
  const schemas = (doc.components as Json | undefined)?.schemas as Json | undefined;
  const refs = new Set<string>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      else collect(value);
    }
  };
  collect(doc);
  assert.ok(refs.size > 0, 'document contains no $refs');
  for (const ref of refs) {
    assert.ok(
      ref.startsWith('#/components/schemas/'),
      `unexpected $ref form "${ref}" (should be a components pointer)`
    );
    const name = ref.slice('#/components/schemas/'.length);
    assert.ok(name in schemas, `$ref "${ref}" does not resolve in components.schemas`);
  }
});

test('live responses validate against the registered schemas (no 500s)', {
  timeout: 30_000
}, async () => {
  const probes = [
    '/api/health',
    '/api/networks',
    '/api/networks/cn-beijing',
    '/api/networks/cn-guangzhou/lines',
    '/api/networks/cn-beijing/stations',
    '/api/networks/cn-beijing/stations/cn-beijing-xizhimen',
    '/api/networks/cn-beijing/stops',
    '/api/networks/cn-beijing/patterns',
    '/api/networks/cn-beijing/segments',
    '/api/networks/cn-beijing/transfers',
    '/api/networks/cn-beijing/timetables',
    '/api/networks/cn-beijing/fares',
    '/api/networks/cn-beijing/graph',
    '/api/networks/cn-beijing/route?from=cn-beijing-pingguoyuan&to=cn-beijing-xizhimen',
    '/api/networks/cn-beijing/travel-times?from=cn-beijing-pingguoyuan&within=600',
    '/api/networks/cn-beijing/nearest?lon=116.4&lat=39.9',
    // Unknown network ids are the documented 404 error shape, not a 500.
    '/api/networks/zzz/lines',
    '/api/networks/cn-beijing/stations/zzz'
  ];
  for (const path of probes) {
    const res = await app.handle(new Request(`http://localhost${path}`));
    assert.notEqual(res.status, 500, `${path} returned 500 — a response violated its schema`);
    if (path.includes('zzz')) {
      assert.equal(res.status, 404, `${path} should be 404`);
      const body = (await res.json()) as Json;
      assert.equal(typeof body.error, 'string', `${path} body must be { error: string }`);
    } else {
      assert.equal(res.status, 200, `${path} should be 200`);
    }
  }
});
