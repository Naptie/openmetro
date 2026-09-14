import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillCoordinates, type KnownLocation } from '../src/geocode/index.js';
import {
  bboxAround,
  bboxOf,
  bd09ToGcj02,
  findOverpassStation,
  indexOverpassStations,
  type OverpassStation,
  wgs84ToGcj02
} from '../src/geocode/overpass.js';
import { foldRareCharacters } from '../src/name-utils.js';

test('wgs84ToGcj02 converts a known point inside China', () => {
  // Tiananmen (WGS84 116.3913,39.9075) -> GCJ-02 ~116.3975,39.9089.
  const p = wgs84ToGcj02(116.3913, 39.9075);
  assert.equal(p.crs, 'gcj02');
  assert.ok(Math.abs(p.lon - 116.39754) < 0.0005, `lon ${p.lon}`);
  assert.ok(Math.abs(p.lat - 39.9089) < 0.0005, `lat ${p.lat}`);
});

test('bd09ToGcj02 inverts the Baidu twist on a Shanghai point', () => {
  // Official shmetro stationInfo: 安亭 BD-09 longitude/latitude, and the
  // paired gao_lng/gao_lat GCJ-02 published in the same payload.
  const p = bd09ToGcj02(121.168602, 31.294335);
  assert.equal(p.crs, 'gcj02');
  assert.ok(Math.abs(p.lon - 121.162083571281) < 1e-9, `lon ${p.lon}`);
  assert.ok(Math.abs(p.lat - 31.2884860493288) < 1e-9, `lat ${p.lat}`);
});

test('wgs84ToGcj02 leaves coordinates outside China untouched', () => {
  const p = wgs84ToGcj02(2.3522, 48.8566); // Paris
  assert.deepEqual(p, { lon: 2.3522, lat: 48.8566, crs: 'gcj02' });
});

test('bboxAround and bboxOf produce sane boxes', () => {
  const b = bboxAround({ lon: 121.48, lat: 31.23 }, 10);
  assert.ok(b[0] < 31.23 && b[2] > 31.23);
  assert.ok(b[1] < 121.48 && b[3] > 121.48);

  assert.equal(bboxOf([]), undefined);
  const tight = bboxOf(
    [
      { lon: 121.0, lat: 31.0 },
      { lon: 122.0, lat: 32.0 }
    ],
    0.5
  );
  assert.deepEqual(tight, [30.5, 120.5, 32.5, 122.5]);
});

function station(name: string, altNames: string[] = []): OverpassStation {
  return {
    name,
    altNames,
    location: { lon: 0, lat: 0, crs: 'gcj02' },
    wgs84: { lon: 0, lat: 0 },
    osmId: 'node/1',
    railway: 'station',
    station: 'subway'
  };
}

test('findOverpassStation matches parenthetical-stripped names', () => {
  const idx = indexOverpassStations([station('广州塔')]);
  assert.equal(findOverpassStation(idx, '广州塔（有轨）')?.name, '广州塔');
  assert.equal(findOverpassStation(idx, '广州塔(有轨)')?.name, '广州塔');
});

test('foldRareCharacters is a no-op without city-specific forms', () => {
  // Core ships no fold forms — adapters supply them (city-agnostic core).
  assert.equal(foldRareCharacters('虫雷 岗'), '虫雷 岗');
  const forms: readonly (readonly [string, string])[] = [['虫雷', '𧒽']];
  assert.equal(foldRareCharacters('虫雷 岗', forms), '𧒽岗');
  assert.equal(foldRareCharacters('虫雷岗', forms), '𧒽岗');
  assert.equal(foldRareCharacters('𧒽岗', forms), '𧒽岗');
});

test('findOverpassStation matches adapter pre-folded names', () => {
  // OSM stores the single character "𧒽"; the adapter folds the decomposed
  // source form before geocoding, so the core sees identical strings.
  const idx = indexOverpassStations([station('𧒽岗')]);
  assert.equal(findOverpassStation(idx, '𧒽岗')?.name, '𧒽岗');
  assert.equal(findOverpassStation(idx, '𧒽岗（有轨）')?.name, '𧒽岗');
});

test('findOverpassStation indexes alternate names', () => {
  const idx = indexOverpassStations([station('人民广场', ["People's Square"])]);
  assert.equal(findOverpassStation(idx, "People's Square")?.name, '人民广场');
  assert.equal(findOverpassStation(idx, 'nope'), undefined);
});

test('fillCoordinates applies knownLocations before any geocoder', async () => {
  // 广州 is inside the CN-GZ bbox; the official coords for 萝峰 are wrong
  // (a neighbouring POI). The KnownLocation must win and record provenance.
  const stations = [
    { id: 'cn-gz-luofeng', names: { zh: '萝峰' } } as any,
    { id: 'cn-gz-other', names: { zh: '香雪' } } as any
  ];
  const known: KnownLocation[] = [
    {
      name: '萝峰',
      location: { lon: 113.512584, lat: 23.178897, crs: 'gcj02' },
      source: 'osm'
    }
  ];
  const out = await fillCoordinates(stations, {
    city: '广州',
    knownLocations: known,
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => [],
      geocode: async () => undefined
    }
  });
  assert.equal(out[0].location?.lon, 113.512584);
  assert.equal(out[0].extras?.location_source, 'osm');
  // Unmatched station left untouched.
  assert.equal(out[1].location, undefined);
});

test('fillCoordinates records provenance for pre-seeded source coords', async () => {
  // A pre-seeded coordinate inside the city bbox survives validation and is
  // recorded as a source-feed location (not a geocoder match).
  const stations = [
    {
      id: 'cn-gz-seeded',
      names: { zh: '香雪公园' },
      location: { lon: 113.501224, lat: 23.172382, crs: 'gcj02' }
    } as any
  ];
  const out = await fillCoordinates(stations, {
    city: '广州',
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => [],
      geocode: async () => undefined
    }
  });
  assert.equal(out[0].location?.lon, 113.501224);
  assert.equal(out[0].extras?.location_source, 'source');
});

test('fillCoordinates drops pre-seeded coords outside the city bbox', async () => {
  // lat 31.14 is Shanghai, far outside CN-GZ's bbox -> dropped, not kept.
  const stations = [
    {
      id: 'cn-gz-seeded',
      names: { zh: '香雪公园' },
      location: { lon: 113.532013, lat: 31.139563, crs: 'gcj02' }
    } as any
  ];
  const out = await fillCoordinates(stations, {
    city: '广州',
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => [],
      geocode: async () => undefined
    }
  });
  assert.equal(out[0].location, undefined);
});
