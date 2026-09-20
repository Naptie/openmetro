import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillCoordinates } from '../src/geocode/index.js';
import {
  evaluateStationSpeed,
  meanLeaveOneOutSpeedKmh,
  type SegmentAdjacency,
  SPEED_VALIDATE
} from '../src/geocode/speed-validate.js';

/** Guangqing corridor fixture: official 神山 coords collide with 江高. */
function guangqingFixture() {
  const stations = [
    {
      id: 'cn-guangzhou-huadu',
      names: { zh: '花都' },
      location: { lon: 113.201384, lat: 23.377115, crs: 'gcj02' as const },
      extras: { location_source: 'official' }
    },
    {
      id: 'cn-guangzhou-shenshan',
      names: { zh: '神山' },
      location: { lon: 113.223422, lat: 23.27669, crs: 'gcj02' as const },
      extras: { location_source: 'official' }
    },
    {
      id: 'cn-guangzhou-jianggao',
      names: { zh: '江高' },
      location: { lon: 113.22339, lat: 23.276722, crs: 'gcj02' as const },
      extras: { location_source: 'official' }
    },
    {
      id: 'cn-guangzhou-baiyunhu',
      names: { zh: '白云湖' },
      location: { lon: 113.237968, lat: 23.225409, crs: 'gcj02' as const },
      extras: { location_source: 'official' }
    },
    {
      id: 'cn-guangzhou-guangzhoubaiyun',
      names: { zh: '广州白云' },
      location: { lon: 113.246341, lat: 23.19091, crs: 'gcj02' as const },
      extras: { location_source: 'official' }
    }
  ];
  const lineId = 'cn-guangzhou-line-guangzhou-qingyuan-intercity';
  const segments: SegmentAdjacency[] = [
    {
      from_station_id: 'cn-guangzhou-huadu',
      to_station_id: 'cn-guangzhou-shenshan',
      line_id: lineId,
      travel_time_seconds: 360,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 'cn-guangzhou-shenshan',
      to_station_id: 'cn-guangzhou-jianggao',
      line_id: lineId,
      travel_time_seconds: 360,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 'cn-guangzhou-jianggao',
      to_station_id: 'cn-guangzhou-baiyunhu',
      line_id: lineId,
      travel_time_seconds: 360,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 'cn-guangzhou-baiyunhu',
      to_station_id: 'cn-guangzhou-guangzhoubaiyun',
      line_id: lineId,
      travel_time_seconds: 360,
      travel_time_source: 'last_train'
    }
  ];
  return { stations, segments, lineId };
}

test('meanLeaveOneOutSpeedKmh excludes the station under test', () => {
  const { stations, segments, lineId } = guangqingFixture();
  const locations = new Map(
    stations.map((s) => [s.id, { lon: s.location!.lon, lat: s.location!.lat }])
  );
  const loo = meanLeaveOneOutSpeedKmh(segments, 'cn-guangzhou-jianggao', [lineId], locations);
  assert.ok(loo);
  // Remaining pairs: 花都-神山 (wrong, very fast) + 白云湖-广州白云.
  assert.equal(loo.n, 2);
  assert.ok(loo.mean > 0);
});

test('evaluateStationSpeed flags colliding official coords as too_close', () => {
  const { stations, segments, lineId } = guangqingFixture();
  const report = evaluateStationSpeed(stations, segments, 'cn-guangzhou-shenshan', {
    lines: [{ id: lineId, mode: 'suburban_rail' }]
  });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.kind === 'too_close'));
  assert.ok(report.violations.some((v) => v.ratio < 0.05));
});

test('evaluateStationSpeed passes after 神山 is moved to Overpass coords', () => {
  const { stations, segments, lineId } = guangqingFixture();
  const fixed = stations.map((s) =>
    s.id === 'cn-guangzhou-shenshan'
      ? {
          ...s,
          location: { lon: 113.201363, lat: 23.32917, crs: 'gcj02' as const },
          extras: { location_source: 'overpass' }
        }
      : s
  );
  const report = evaluateStationSpeed(fixed, segments, 'cn-guangzhou-shenshan', {
    lines: [{ id: lineId, mode: 'suburban_rail' }]
  });
  assert.equal(report.ok, true, JSON.stringify(report.violations));
});

test('evaluateStationSpeed skips untrusted default travel times', () => {
  const stations = [
    {
      id: 'a',
      names: { zh: 'A' },
      location: { lon: 113.2, lat: 23.2, crs: 'gcj02' as const }
    },
    {
      id: 'b',
      names: { zh: 'B' },
      location: { lon: 113.2001, lat: 23.2, crs: 'gcj02' as const }
    },
    {
      id: 'c',
      names: { zh: 'C' },
      location: { lon: 113.25, lat: 23.2, crs: 'gcj02' as const }
    },
    {
      id: 'd',
      names: { zh: 'D' },
      location: { lon: 113.3, lat: 23.2, crs: 'gcj02' as const }
    }
  ];
  const segments: SegmentAdjacency[] = [
    {
      from_station_id: 'a',
      to_station_id: 'b',
      line_id: 'L',
      travel_time_seconds: 600,
      travel_time_source: 'default'
    },
    {
      from_station_id: 'b',
      to_station_id: 'c',
      line_id: 'L',
      travel_time_seconds: 180,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 'c',
      to_station_id: 'd',
      line_id: 'L',
      travel_time_seconds: 180,
      travel_time_source: 'last_train'
    }
  ];
  // Baseline for B uses only c-d (b-c involves B). Need ≥2 — add another pair.
  segments.push({
    from_station_id: 'c',
    to_station_id: 'd',
    line_id: 'L',
    travel_time_seconds: 180,
    travel_time_source: 'source'
  } as SegmentAdjacency);
  const report = evaluateStationSpeed(stations, segments, 'a', {
    lines: [{ id: 'L', mode: 'metro' }]
  });
  // Segment a-b is untrusted → no timed neighbour evidence for a.
  assert.equal(report.ok, true);
});

test('fillCoordinates falls back official → overpass when speed validation fails', async () => {
  const { segments, lineId } = guangqingFixture();
  const stations = [
    { id: 'cn-guangzhou-huadu', names: { zh: '花都' } } as any,
    { id: 'cn-guangzhou-shenshan', names: { zh: '神山' } } as any,
    { id: 'cn-guangzhou-jianggao', names: { zh: '江高' } } as any,
    { id: 'cn-guangzhou-baiyunhu', names: { zh: '白云湖' } } as any,
    { id: 'cn-guangzhou-guangzhoubaiyun', names: { zh: '广州白云' } } as any
  ];
  const official = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>([
    ['花都', { lon: 113.201384, lat: 23.377115, crs: 'gcj02' }],
    ['神山', { lon: 113.223422, lat: 23.27669, crs: 'gcj02' }],
    ['江高', { lon: 113.22339, lat: 23.276722, crs: 'gcj02' }],
    ['白云湖', { lon: 113.237968, lat: 23.225409, crs: 'gcj02' }],
    ['广州白云', { lon: 113.246341, lat: 23.19091, crs: 'gcj02' }]
  ]);
  const overpassStations = [
    {
      name: '花都',
      altNames: [],
      location: { lon: 113.202782, lat: 23.377321, crs: 'gcj02' as const },
      wgs84: { lon: 113.197396, lat: 23.379877 },
      osmId: 'node/1',
      railway: 'station'
    },
    {
      name: '神山',
      altNames: [],
      location: { lon: 113.201363, lat: 23.32917, crs: 'gcj02' as const },
      wgs84: { lon: 113.195978, lat: 23.331733 },
      osmId: 'node/2',
      railway: 'station'
    },
    {
      name: '江高',
      altNames: [],
      location: { lon: 113.224363, lat: 23.277535, crs: 'gcj02' as const },
      wgs84: { lon: 113.219013, lat: 23.280145 },
      osmId: 'node/3',
      railway: 'station'
    },
    {
      name: '白云湖',
      altNames: [],
      location: { lon: 113.238271, lat: 23.224869, crs: 'gcj02' as const },
      wgs84: { lon: 113.232937, lat: 23.227508 },
      osmId: 'node/4',
      railway: 'station'
    },
    {
      name: '广州白云',
      altNames: [],
      location: { lon: 113.245839, lat: 23.191383, crs: 'gcj02' as const },
      wgs84: { lon: 113.24051, lat: 23.194037 },
      osmId: 'node/5',
      railway: 'station'
    }
  ];

  const out = await fillCoordinates(stations, {
    city: '广州',
    stops: [
      { station_id: 'cn-guangzhou-huadu', line_id: lineId },
      { station_id: 'cn-guangzhou-shenshan', line_id: lineId },
      { station_id: 'cn-guangzhou-jianggao', line_id: lineId },
      { station_id: 'cn-guangzhou-baiyunhu', line_id: lineId },
      { station_id: 'cn-guangzhou-guangzhoubaiyun', line_id: lineId }
    ],
    lines: [{ id: lineId, mode: 'suburban_rail' }],
    officialLocations: official,
    segments,
    speedValidate: true,
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => overpassStations,
      geocode: async () => undefined
    }
  });

  const shenshan = out.find((s) => s.id === 'cn-guangzhou-shenshan');
  assert.ok(shenshan?.location);
  assert.equal(shenshan.extras?.location_source, 'overpass');
  assert.ok(Math.abs(shenshan.location!.lat - 23.32917) < 1e-6);
  const jianggao = out.find((s) => s.id === 'cn-guangzhou-jianggao');
  assert.ok(jianggao?.location);
  // Either official or overpass 江高 is acceptable once 神山 is fixed.
  assert.ok(['official', 'overpass'].includes(String(jianggao.extras?.location_source)));
});

test('fillCoordinates throws when no source candidate passes speed validation', async () => {
  const { segments, lineId } = guangqingFixture();
  const stations = [
    { id: 'cn-guangzhou-huadu', names: { zh: '花都' } } as any,
    { id: 'cn-guangzhou-shenshan', names: { zh: '神山' } } as any,
    { id: 'cn-guangzhou-jianggao', names: { zh: '江高' } } as any,
    { id: 'cn-guangzhou-baiyunhu', names: { zh: '白云湖' } } as any,
    { id: 'cn-guangzhou-guangzhoubaiyun', names: { zh: '广州白云' } } as any
  ];
  const official = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>([
    ['花都', { lon: 113.201384, lat: 23.377115, crs: 'gcj02' }],
    // Both collide — and no other source is provided.
    ['神山', { lon: 113.223422, lat: 23.27669, crs: 'gcj02' }],
    ['江高', { lon: 113.22339, lat: 23.276722, crs: 'gcj02' }],
    ['白云湖', { lon: 113.237968, lat: 23.225409, crs: 'gcj02' }],
    ['广州白云', { lon: 113.246341, lat: 23.19091, crs: 'gcj02' }]
  ]);

  await assert.rejects(
    () =>
      fillCoordinates(stations, {
        city: '广州',
        stops: [
          { station_id: 'cn-guangzhou-huadu', line_id: lineId },
          { station_id: 'cn-guangzhou-shenshan', line_id: lineId },
          { station_id: 'cn-guangzhou-jianggao', line_id: lineId },
          { station_id: 'cn-guangzhou-baiyunhu', line_id: lineId },
          { station_id: 'cn-guangzhou-guangzhoubaiyun', line_id: lineId }
        ],
        lines: [{ id: lineId, mode: 'suburban_rail' }],
        officialLocations: official,
        segments,
        speedValidate: true,
        failOnInvalidCoordinates: true,
        fetchers: {
          fetchSubway: async () => [],
          fetchOverpass: async () => [],
          geocode: async () => undefined
        }
      }),
    /speed validation failed/i
  );
});

test('fillCoordinates enumeration is order-independent (fixes 神山 via k=1)', async () => {
  // Same Guangqing collision: sequential worst-first used to "fix" 江高 first
  // with a photon POI. Combined k-enumeration must land on 神山 overpass
  // (tried when 江高-only k=1 still fails), with 江高 left at official.
  const { segments, lineId } = guangqingFixture();
  const stations = [
    { id: 'cn-guangzhou-huadu', names: { zh: '花都' } } as any,
    { id: 'cn-guangzhou-shenshan', names: { zh: '神山' } } as any,
    { id: 'cn-guangzhou-jianggao', names: { zh: '江高' } } as any,
    { id: 'cn-guangzhou-baiyunhu', names: { zh: '白云湖' } } as any,
    { id: 'cn-guangzhou-guangzhoubaiyun', names: { zh: '广州白云' } } as any
  ];
  const official = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>([
    ['花都', { lon: 113.201384, lat: 23.377115, crs: 'gcj02' }],
    ['神山', { lon: 113.223422, lat: 23.27669, crs: 'gcj02' }],
    ['江高', { lon: 113.22339, lat: 23.276722, crs: 'gcj02' }],
    ['白云湖', { lon: 113.237968, lat: 23.225409, crs: 'gcj02' }],
    ['广州白云', { lon: 113.246341, lat: 23.19091, crs: 'gcj02' }]
  ]);
  const overpassStations = [
    {
      name: '花都',
      altNames: [],
      location: { lon: 113.202782, lat: 23.377321, crs: 'gcj02' as const },
      wgs84: { lon: 113.197396, lat: 23.379877 },
      osmId: 'node/1',
      railway: 'station'
    },
    {
      name: '神山',
      altNames: [],
      location: { lon: 113.201363, lat: 23.32917, crs: 'gcj02' as const },
      wgs84: { lon: 113.195978, lat: 23.331733 },
      osmId: 'node/2',
      railway: 'station'
    },
    {
      name: '江高',
      altNames: [],
      // Near official 江高 — still collides with official 神山, so k=1 on
      // 江高 alone must fail; enumeration should then try 神山 k=1.
      location: { lon: 113.224363, lat: 23.277535, crs: 'gcj02' as const },
      wgs84: { lon: 113.219013, lat: 23.280145 },
      osmId: 'node/3',
      railway: 'station'
    },
    {
      name: '白云湖',
      altNames: [],
      location: { lon: 113.238271, lat: 23.224869, crs: 'gcj02' as const },
      wgs84: { lon: 113.232937, lat: 23.227508 },
      osmId: 'node/4',
      railway: 'station'
    },
    {
      name: '广州白云',
      altNames: [],
      location: { lon: 113.245839, lat: 23.191383, crs: 'gcj02' as const },
      wgs84: { lon: 113.24051, lat: 23.194037 },
      osmId: 'node/5',
      railway: 'station'
    }
  ];
  // Photon offers a wrong town POI for 江高 — must NOT be chosen if overpass 神山 works.
  const photonHits: Record<string, { lon: number; lat: number; crs: 'gcj02' }> = {
    江高: { lon: 113.23506, lat: 23.275046, crs: 'gcj02' },
    神山: { lon: 113.201363, lat: 23.32917, crs: 'gcj02' }
  };

  const out = await fillCoordinates(stations, {
    city: '广州',
    stops: [
      { station_id: 'cn-guangzhou-huadu', line_id: lineId },
      { station_id: 'cn-guangzhou-shenshan', line_id: lineId },
      { station_id: 'cn-guangzhou-jianggao', line_id: lineId },
      { station_id: 'cn-guangzhou-baiyunhu', line_id: lineId },
      { station_id: 'cn-guangzhou-guangzhoubaiyun', line_id: lineId }
    ],
    lines: [{ id: lineId, mode: 'suburban_rail' }],
    officialLocations: official,
    segments,
    speedValidate: true,
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => overpassStations,
      geocode: async (name: string) => photonHits[name]
    }
  });

  const shenshan = out.find((s) => s.id === 'cn-guangzhou-shenshan');
  assert.equal(shenshan?.extras?.location_source, 'overpass');
  assert.ok(Math.abs(shenshan!.location!.lat - 23.32917) < 1e-6);
  const jianggao = out.find((s) => s.id === 'cn-guangzhou-jianggao');
  // 江高 stays on official once 神山 is corrected — not the photon town POI.
  assert.equal(jianggao?.extras?.location_source, 'official');
  assert.ok(Math.abs(jianggao!.location!.lat - 23.276722) < 1e-6);
});

test('fillCoordinates enumeration requires simultaneous k=1 when single fix is not enough', async () => {
  // Avoid 2-decimal "grid" coords — fillCoordinates treats those as coarse
  // and drops them, which would leave LOO without a baseline.
  const P = { lon: 113.201234, lat: 23.201234 };
  const overA = { lon: 113.202034, lat: 23.201234 }; // ~82 m east of P
  const overB = { lon: 113.200434, lat: 23.201234 }; // ~82 m west of P
  const stations = [
    { id: 's-a', names: { zh: '甲' } } as any,
    { id: 's-b', names: { zh: '乙' } } as any,
    { id: 's-c', names: { zh: '丙' } } as any,
    { id: 's-d', names: { zh: '丁' } } as any,
    { id: 's-e', names: { zh: '戊' } } as any
  ];
  const official = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>([
    ['甲', { ...P, crs: 'gcj02' }],
    ['乙', { lon: 113.201235, lat: 23.201234, crs: 'gcj02' }],
    ['丙', { lon: 113.241234, lat: 23.201234, crs: 'gcj02' }],
    ['丁', { lon: 113.281234, lat: 23.201234, crs: 'gcj02' }],
    ['戊', { lon: 113.321234, lat: 23.201234, crs: 'gcj02' }]
  ]);
  const lineId = 'L';
  const segments: SegmentAdjacency[] = [
    {
      from_station_id: 's-a',
      to_station_id: 's-b',
      line_id: lineId,
      travel_time_seconds: 30,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 's-b',
      to_station_id: 's-c',
      line_id: lineId,
      travel_time_seconds: 240,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 's-c',
      to_station_id: 's-d',
      line_id: lineId,
      travel_time_seconds: 240,
      travel_time_source: 'last_train'
    },
    {
      from_station_id: 's-d',
      to_station_id: 's-e',
      line_id: lineId,
      travel_time_seconds: 240,
      travel_time_source: 'last_train'
    }
  ];
  const overpassStations = [
    {
      name: '甲',
      altNames: [],
      location: { ...overA, crs: 'gcj02' as const },
      wgs84: overA,
      osmId: 'node/a',
      railway: 'station'
    },
    {
      name: '乙',
      altNames: [],
      location: { ...overB, crs: 'gcj02' as const },
      wgs84: overB,
      osmId: 'node/b',
      railway: 'station'
    },
    {
      name: '丙',
      altNames: [],
      location: { lon: 113.241234, lat: 23.201234, crs: 'gcj02' as const },
      wgs84: { lon: 113.241234, lat: 23.201234 },
      osmId: 'node/c',
      railway: 'station'
    },
    {
      name: '丁',
      altNames: [],
      location: { lon: 113.281234, lat: 23.201234, crs: 'gcj02' as const },
      wgs84: { lon: 113.281234, lat: 23.201234 },
      osmId: 'node/d',
      railway: 'station'
    },
    {
      name: '戊',
      altNames: [],
      location: { lon: 113.321234, lat: 23.201234, crs: 'gcj02' as const },
      wgs84: { lon: 113.321234, lat: 23.201234 },
      osmId: 'node/e',
      railway: 'station'
    }
  ];

  const out = await fillCoordinates(stations, {
    city: '广州',
    stops: [
      { station_id: 's-a', line_id: lineId },
      { station_id: 's-b', line_id: lineId },
      { station_id: 's-c', line_id: lineId },
      { station_id: 's-d', line_id: lineId },
      { station_id: 's-e', line_id: lineId }
    ],
    lines: [{ id: lineId, mode: 'metro' }],
    officialLocations: official,
    segments,
    speedValidate: true,
    fetchers: {
      fetchSubway: async () => [],
      fetchOverpass: async () => overpassStations,
      geocode: async () => undefined
    }
  });

  const a = out.find((s) => s.id === 's-a');
  const b = out.find((s) => s.id === 's-b');
  assert.equal(a?.extras?.location_source, 'overpass');
  assert.equal(b?.extras?.location_source, 'overpass');
});

test('SPEED_VALIDATE thresholds are the calibrated defaults', () => {
  assert.equal(SPEED_VALIDATE.tooCloseDistM, 120);
  assert.equal(SPEED_VALIDATE.tooCloseTimeS, 120);
  assert.equal(SPEED_VALIDATE.ratioMin, 0.2);
  assert.equal(SPEED_VALIDATE.ratioMax, 4.0);
  assert.equal(SPEED_VALIDATE.minBaselineSegments, 2);
});
