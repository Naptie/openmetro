import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeNetworkQuality } from '../src/data/quality.js';

const station = (location: unknown, extras?: Record<string, unknown>) => ({
  location,
  names: { zh: '站', en: 'Stn' },
  extras
});

const base = {
  lines: [{ id: 'l1' }],
  segments: [{ travel_time_source: 'last_train' as const }],
  transfers: [{ walk_time_seconds: 300, source_id: 'derived' }],
  timetables: [{ first_train: ['05:00'], last_train: ['23:00'] }],
  stops: [{ schematic: { x: 1, y: 2 } }]
};

test('coordinates with recognized geocode sources are not default', () => {
  const q = computeNetworkQuality({
    ...base,
    stations: [
      station({ lon: 1, lat: 2, crs: 'gcj02' }, { location_source: 'subway' }),
      station({ lon: 1, lat: 2, crs: 'gcj02' }, { location_source: 'overpass' }),
      station({ lon: 1, lat: 2, crs: 'gcj02' }, { location_source: 'photon' })
    ]
  });
  assert.equal(q.coordinates.coverage, 1);
  assert.equal(q.coordinates.status, 'derived'); // majority derived (2) vs official (1)
  assert.equal(q.coordinates.counts.official, 1);
  assert.equal(q.coordinates.counts.derived, 2);
  assert.equal(q.coordinates.counts.default, 0);
});

test('coordinates present without location_source still count as covered', () => {
  const q = computeNetworkQuality({
    ...base,
    stations: [
      station({ lon: 120.6, lat: 31.3, crs: 'gcj02' }),
      station({ lon: 120.7, lat: 31.4, crs: 'gcj02' }, { location_source: 'mystery-geocoder' })
    ]
  });
  // Presence of a location implies a real-world point was resolved; treat
  // untagged / alternate geocoder tags as derived rather than missing.
  assert.equal(q.coordinates.coverage, 1);
  assert.notEqual(q.coordinates.status, 'unavailable');
  assert.equal(q.coordinates.counts.default, 0);
  assert.equal(q.coordinates.counts.derived, 2);
});

test('amap subway coordinates count as official', () => {
  const q = computeNetworkQuality({
    ...base,
    stations: [station({ lon: 1, lat: 2, crs: 'gcj02' }, { location_source: 'subway' })]
  });
  assert.equal(q.coordinates.coverage, 1);
  assert.equal(q.coordinates.precision, 'official');
  assert.equal(q.coordinates.status, 'complete');
});

test('missing coordinates remain default / unavailable', () => {
  const q = computeNetworkQuality({
    ...base,
    stations: [station(undefined), station(null)]
  });
  assert.equal(q.coordinates.coverage, 0);
  assert.equal(q.coordinates.status, 'unavailable');
  assert.equal(q.coordinates.counts.default, 2);
});

test('mixed official + missing is partial with partial coverage', () => {
  const q = computeNetworkQuality({
    ...base,
    stations: [
      station({ lon: 1, lat: 2, crs: 'gcj02' }, { location_source: 'official' }),
      station(undefined)
    ]
  });
  assert.equal(q.coordinates.coverage, 0.5);
  assert.equal(q.coordinates.status, 'partial');
  assert.equal(q.coordinates.counts.official, 1);
  assert.equal(q.coordinates.counts.default, 1);
});
