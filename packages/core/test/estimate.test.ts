import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeNetworkQuality } from '../src/data/quality.js';
import type { SegmentEncoded } from '../src/schema/index.js';
import { estimateTimesFromDistanceSpeed } from '../src/timetable/estimate.js';

function segment(
  id: string,
  lineId: string,
  distanceKm: number,
  options: {
    seconds?: number;
    source?: 'source' | 'planner' | 'last_train' | 'estimated';
    timeEstimate?: string;
  } = {}
): SegmentEncoded {
  return {
    id,
    line_id: lineId,
    from_stop_id: `${id}-from`,
    to_stop_id: `${id}-to`,
    from_station_id: `${id}-from-station`,
    to_station_id: `${id}-to-station`,
    direction: 'both',
    distance_km: distanceKm,
    ...(options.seconds == null ? {} : { travel_time_seconds: options.seconds }),
    ...(options.source == null ? {} : { travel_time_source: options.source }),
    ...(options.timeEstimate == null ? {} : { extras: { time_estimate: options.timeEstimate } })
  };
}

const affineSamples = (lineId: string) => [
  segment(`${lineId}-short-1`, lineId, 1, { seconds: 130, source: 'source' }),
  segment(`${lineId}-short-2`, lineId, 2, { seconds: 170, source: 'planner' }),
  segment(`${lineId}-short-3`, lineId, 3, { seconds: 210, source: 'last_train' })
];

test('fits a line-specific slope and positive per-hop overhead', () => {
  const target = segment('express-long', 'express', 18);
  const [estimated] = estimateTimesFromDistanceSpeed([...affineSamples('express'), target]).slice(
    -1
  );

  assert.equal(estimated?.travel_time_seconds, 810);
  assert.equal(estimated?.extras?.time_estimate, 'distance_time_affine');
  assert.equal(estimated?.extras?.a_s_per_km, 40);
  assert.equal(estimated?.extras?.b_s, 90);
});

test('falls back to the network affine fit when a line is undersampled', () => {
  const target = segment('airport-long', 'airport', 18);
  const result = estimateTimesFromDistanceSpeed([...affineSamples('calibration'), target]);

  assert.equal(result.at(-1)?.travel_time_seconds, 810);
  assert.equal(result.at(-1)?.extras?.time_estimate, 'distance_time_affine');
});

test('preserves trusted times, upgrades legacy estimates, and keeps affine estimates stable', () => {
  const trusted = affineSamples('express');
  const legacy = segment('legacy', 'express', 18, {
    seconds: 2088,
    source: 'estimated',
    timeEstimate: 'distance_speed'
  });
  const affine = segment('already-affine', 'express', 18, {
    seconds: 810,
    source: 'estimated',
    timeEstimate: 'distance_time_affine'
  });
  const result = estimateTimesFromDistanceSpeed([...trusted, legacy, affine]);

  assert.deepEqual(result.slice(0, trusted.length), trusted);
  assert.equal(result[3]?.travel_time_seconds, 810);
  assert.equal(result[3]?.extras?.time_estimate, 'distance_time_affine');
  assert.equal(result[4], affine);
});

test('falls back to median speed when there are too few trusted samples', () => {
  const known = segment('known', 'line', 1, { seconds: 90, source: 'source' });
  const target = segment('missing', 'line', 2);
  const result = estimateTimesFromDistanceSpeed([known, target]);

  assert.equal(result[1]?.travel_time_seconds, 180);
  assert.equal(result[1]?.extras?.time_estimate, 'distance_speed');
});

test('classifies affine time estimates as derived quality', () => {
  const quality = computeNetworkQuality({
    stations: [],
    segments: [
      {
        travel_time_source: 'estimated',
        distance_km: 18,
        extras: { time_estimate: 'distance_time_affine' }
      }
    ],
    transfers: []
  });

  assert.equal(quality.segment_times.precision, 'derived');
});
