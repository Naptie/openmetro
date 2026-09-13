import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';
import { FareMatrix, Line, Station } from '../src/schema/index.js';

test('Line requires multilingual names with zh and en', () => {
  const ok = {
    id: 'l1',
    name: '1号线',
    names: { zh: '1号线', en: 'Line 1' },
    mode: 'metro',
    status: 'operating',
    loop: false,
    aliases: [],
    source_ids: []
  };
  const decoded = Schema.decodeUnknownSync(Line)(ok);
  assert.equal(decoded.names.zh, '1号线');
  assert.equal(decoded.names.en, 'Line 1');
});

test('Line with missing en is rejected', () => {
  const bad = {
    id: 'l1',
    name: '1号线',
    names: { zh: '1号线' },
    mode: 'metro',
    status: 'operating',
    loop: false,
    aliases: [],
    source_ids: []
  };
  assert.throws(() => Schema.decodeUnknownSync(Line)(bad));
});

test('Station requires multilingual names with zh and en', () => {
  const ok = {
    id: 's1',
    name: '苹果园',
    names: { zh: '苹果园', en: 'Pingguoyuan' },
    status: 'operating',
    source_ids: []
  };
  const decoded = Schema.decodeUnknownSync(Station)(ok);
  assert.equal(decoded.names.en, 'Pingguoyuan');
});

test('Station with missing en is rejected', () => {
  const bad = {
    id: 's1',
    name: '苹果园',
    names: { zh: '苹果园' },
    status: 'operating',
    source_ids: []
  };
  assert.throws(() => Schema.decodeUnknownSync(Station)(bad));
});

const fareMatrix = {
  $schema: 'x',
  schema_version: '1.0',
  network_id: 'cn-bj',
  generated_at: '2026-09-09T00:00:00.000Z',
  source: [],
  currency: 'CNY',
  unit: 'yuan',
  station_ids: ['a', 'b'],
  fares: [
    [0, 5],
    [5, 0]
  ]
};

test('FareMatrix decodes a symmetric matrix', () => {
  const decoded = Schema.decodeUnknownSync(FareMatrix)(fareMatrix);
  assert.equal(decoded.fares[0][1], 5);
  assert.equal(decoded.unit, 'yuan');
});

test('FareMatrix allows null for unpublished pairs', () => {
  const withNull = {
    ...fareMatrix,
    fares: [
      [0, null],
      [null, 0]
    ]
  };
  assert.doesNotThrow(() => Schema.decodeUnknownSync(FareMatrix)(withNull));
});

test('FareMatrix rejects a malformed value', () => {
  const bad = {
    ...fareMatrix,
    fares: [
      [0, '5'],
      [5, 0]
    ]
  };
  assert.throws(() => Schema.decodeUnknownSync(FareMatrix)(bad));
});
