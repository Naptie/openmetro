import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bboxAround,
  bboxOf,
  findOverpassStation,
  indexOverpassStations,
  type OverpassStation,
  wgs84ToGcj02,
} from "../src/geocode/overpass.js";

test("wgs84ToGcj02 converts a known point inside China", () => {
  // Tiananmen (WGS84 116.3913,39.9075) -> GCJ-02 ~116.3975,39.9089.
  const p = wgs84ToGcj02(116.3913, 39.9075);
  assert.equal(p.crs, "gcj02");
  assert.ok(Math.abs(p.lon - 116.39754) < 0.0005, `lon ${p.lon}`);
  assert.ok(Math.abs(p.lat - 39.9089) < 0.0005, `lat ${p.lat}`);
});

test("wgs84ToGcj02 leaves coordinates outside China untouched", () => {
  const p = wgs84ToGcj02(2.3522, 48.8566); // Paris
  assert.deepEqual(p, { lon: 2.3522, lat: 48.8566, crs: "gcj02" });
});

test("bboxAround and bboxOf produce sane boxes", () => {
  const b = bboxAround({ lon: 121.48, lat: 31.23 }, 10);
  assert.ok(b[0] < 31.23 && b[2] > 31.23);
  assert.ok(b[1] < 121.48 && b[3] > 121.48);

  assert.equal(bboxOf([]), undefined);
  const tight = bboxOf(
    [
      { lon: 121.0, lat: 31.0 },
      { lon: 122.0, lat: 32.0 },
    ],
    0.5,
  );
  assert.deepEqual(tight, [30.5, 120.5, 32.5, 122.5]);
});

function station(name: string, altNames: string[] = []): OverpassStation {
  return {
    name,
    altNames,
    location: { lon: 0, lat: 0, crs: "gcj02" },
    wgs84: { lon: 0, lat: 0 },
    osmId: "node/1",
    railway: "station",
    station: "subway",
  };
}

test("findOverpassStation matches parenthetical-stripped names", () => {
  const idx = indexOverpassStations([station("广州塔")]);
  assert.equal(findOverpassStation(idx, "广州塔（有轨）")?.name, "广州塔");
  assert.equal(findOverpassStation(idx, "广州塔(有轨)")?.name, "广州塔");
});

test("findOverpassStation matches decomposed rare characters", () => {
  // OSM stores the single character "𧒽"; the source data decomposes it.
  const idx = indexOverpassStations([station("𧒽岗")]);
  assert.equal(findOverpassStation(idx, "虫雷 岗")?.name, "𧒽岗");
  assert.equal(findOverpassStation(idx, "虫雷岗")?.name, "𧒽岗");
});

test("findOverpassStation indexes alternate names", () => {
  const idx = indexOverpassStations([station("人民广场", ["People's Square"])]);
  assert.equal(findOverpassStation(idx, "People's Square")?.name, "人民广场");
  assert.equal(findOverpassStation(idx, "nope"), undefined);
});
