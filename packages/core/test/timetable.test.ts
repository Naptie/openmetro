import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDerivedTimes, deriveSegmentTimes } from '../src/timetable/derive.js';
import { isInService, statusForRecord } from '../src/timetable/status.js';
import {
  effectiveTime,
  normalizeTimetableTimes,
  parseHHMM,
  weekdayToMonBased
} from '../src/timetable/time.js';

const stops = [
  { id: 's-a', station_id: 'st-a', line_id: 'l1', sequence: 0 },
  { id: 's-b', station_id: 'st-b', line_id: 'l1', sequence: 1 },
  { id: 's-c', station_id: 'st-c', line_id: 'l1', sequence: 2 },
  { id: 's-d', station_id: 'st-d', line_id: 'l1', sequence: 3 },
  { id: 's-e', station_id: 'st-e', line_id: 'l1', sequence: 4 }
] as any;

const mainPattern = {
  id: 'p-main',
  line_id: 'l1',
  stop_ids: ['s-a', 's-b', 's-c'],
  origin_stop_id: 's-a',
  terminal_stop_id: 's-c',
  is_primary: true,
  source_ids: []
} as any;

const branchPattern = {
  id: 'p-branch',
  line_id: 'l1',
  stop_ids: ['s-d', 's-e', 's-b', 's-c'],
  origin_stop_id: 's-d',
  terminal_stop_id: 's-c',
  is_primary: false,
  junction_stop_id: 's-b',
  source_ids: []
} as any;

const tt = (stop: string, destination: string, last: string, first = '06:00') =>
  ({
    id: `tt-${stop}-${destination}`,
    station_id: `st-${stop.slice(2)}`,
    stop_id: stop,
    line_id: 'l1',
    destination_stop_id: destination,
    first_train: [first],
    last_train: [last]
  }) as any;

test('parseHHMM handles times and midnight rollover', () => {
  assert.equal(parseHHMM('05:30'), 330);
  assert.equal(parseHHMM('23:35'), 1415);
  assert.equal(parseHHMM('24:10'), 1450);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('99:99'), null);
});

test('effectiveTime supports 1 and 7 element arrays', () => {
  assert.equal(effectiveTime(['06:00'], 3), 360);
  assert.equal(
    effectiveTime(['06:00', '06:05', '06:00', '06:00', '06:00', '06:00', '06:00'], 1),
    365
  );
  assert.equal(effectiveTime([], 0), null);
});

test('weekdayToMonBased maps JS day to Mon-based', () => {
  // JS: 0=Sun..6=Sat -> Mon-based: 0=Mon..6=Sun
  assert.equal(weekdayToMonBased(1), 0); // Mon
  assert.equal(weekdayToMonBased(5), 4); // Fri
  assert.equal(weekdayToMonBased(6), 5); // Sat
  assert.equal(weekdayToMonBased(0), 6); // Sun
});

test('deriveSegmentTimes computes deltas along a pattern', () => {
  const tts = [tt('s-a', 's-c', '22:00'), tt('s-b', 's-c', '22:02'), tt('s-c', 's-a', '22:04')];
  const derived = deriveSegmentTimes([mainPattern], stops, tts, {});
  assert.equal(derived.length, 2);
  assert.equal(derived[0].travel_time_seconds, 120);
  assert.equal(derived[1].travel_time_seconds, 120);
  assert.equal(derived[0].travel_time_source, 'last_train');
});

test('deriveSegmentTimes derives branch segments independently', () => {
  const tts = [
    tt('s-a', 's-c', '22:00'),
    tt('s-b', 's-c', '22:02'),
    tt('s-c', 's-a', '22:04'),
    tt('s-d', 's-c', '21:58'),
    tt('s-e', 's-c', '22:00')
  ];
  const derived = deriveSegmentTimes([mainPattern, branchPattern], stops, tts, {});
  const pairs = derived.map((d) => `${d.from_stop_id}->${d.to_stop_id}`);
  assert.ok(pairs.includes('s-a->s-b'));
  assert.ok(pairs.includes('s-d->s-e'));
  // The branch-junction connector is left to the estimated fallback.
  assert.ok(!pairs.includes('s-e->s-b'));
  // No phantom edge across the branch.
  assert.ok(!pairs.includes('s-a->s-d'));
});

test('deriveSegmentTimes rejects non-monotonic chains', () => {
  const tts = [
    tt('s-a', 's-c', '22:40'),
    tt('s-b', 's-c', '22:30'), // goes backwards -> invalid
    tt('s-c', 's-a', '22:50')
  ];
  const derived = deriveSegmentTimes([mainPattern], stops, tts, {});
  assert.equal(derived.length, 0);
});

test('applyDerivedTimes fills gaps without mutating source segments', () => {
  const segments = [
    {
      id: 'seg1',
      line_id: 'l1',
      from_stop_id: 's-a',
      to_stop_id: 's-b',
      from_station_id: 'st-a',
      to_station_id: 'st-b',
      direction: 'both'
    },
    {
      id: 'seg2',
      line_id: 'l1',
      from_stop_id: 's-b',
      to_stop_id: 's-c',
      from_station_id: 'st-b',
      to_station_id: 'st-c',
      direction: 'both',
      travel_time_seconds: 180,
      travel_time_source: 'source'
    }
  ] as any;
  const derived = [
    {
      id: 'd1',
      line_id: 'l1',
      from_stop_id: 's-a',
      to_stop_id: 's-b',
      from_station_id: 'st-a',
      to_station_id: 'st-b',
      travel_time_seconds: 120,
      travel_time_source: 'last_train',
      travel_time_derived_from: ['tt-a', 'tt-b']
    },
    {
      id: 'd2',
      line_id: 'l1',
      from_stop_id: 's-b',
      to_stop_id: 's-c',
      from_station_id: 'st-b',
      to_station_id: 'st-c',
      travel_time_seconds: 120,
      travel_time_source: 'last_train',
      travel_time_derived_from: ['tt-b', 'tt-c']
    }
  ] as any;
  const merged = applyDerivedTimes(segments, derived);
  assert.equal(merged[0].travel_time_seconds, 120);
  assert.equal(merged[0].travel_time_source, 'last_train');
  // seg2 already had a source time -> keep it.
  assert.equal(merged[1].travel_time_seconds, 180);
  assert.equal(merged[1].travel_time_source, 'source');
});

test('statusForRecord reports in-service within hours', () => {
  const rec = tt('s-a', 's-c', '23:30', '05:30');
  const now = new Date('2026-09-07T04:00:00Z'); // 12:00 in Asia/Shanghai
  const st = statusForRecord(rec, now, 'Asia/Shanghai');
  assert.equal(st.is_in_service, true);
  assert.equal(st.first_train, '05:30');
  assert.equal(st.last_train, '23:30');
  assert.equal(st.destination_stop_id, 's-c');
  assert.equal(st.timezone, 'Asia/Shanghai');
  assert.equal(st.now, '12:00');
});

test("statusForRecord evaluates in the network timezone, not the server's", () => {
  const rec = tt('s-a', 's-c', '23:30', '05:30');
  const now = new Date('2026-09-07T17:00:00Z'); // 01:00 next day in Asia/Shanghai
  const shanghai = statusForRecord(rec, now, 'Asia/Shanghai');
  const utc = statusForRecord(rec, now, 'UTC');
  assert.equal(shanghai.is_in_service, false);
  assert.equal(shanghai.now, '01:00');
  assert.equal(utc.is_in_service, true);
  assert.equal(utc.now, '17:00');
});

test('normalizeTimetableTimes rewrites 00:xx wraps to the service-day 24:xx form', () => {
  const rec = tt('s-a', 's-c', '00:30', '05:30');
  const normalized = normalizeTimetableTimes(rec);
  assert.deepEqual(normalized.last_train, ['24:30']);
  // Idempotent: already-normalized times are untouched.
  assert.deepEqual(normalizeTimetableTimes(normalized).last_train, ['24:30']);
  // In-service (morning) times are untouched.
  assert.deepEqual(normalizeTimetableTimes(tt('s-a', 's-c', '23:30', '05:30')).last_train, [
    '23:30'
  ]);
});

test('normalizeTimetableTimes handles per-day weekend extensions', () => {
  const rec = {
    ...tt('s-a', 's-c', '22:32', '05:30'),
    last_train: ['22:32', '22:32', '22:32', '22:32', '22:32', '24:00', '25:02']
  };
  const normalized = normalizeTimetableTimes(rec);
  assert.deepEqual(normalized.last_train, [
    '22:32',
    '22:32',
    '22:32',
    '22:32',
    '22:32',
    '24:00',
    '25:02'
  ]);
});

test("isInService reaches the previous day's after-midnight tail", () => {
  // Saturday's last train at 25:02 (Sunday 01:02) is still running at 00:30 Sun.
  const overnight = {
    ...tt('s-a', 's-c', '25:02', '05:30'),
    last_train: ['23:30', '23:30', '23:30', '23:30', '23:30', '25:02', '25:02']
  };
  assert.equal(isInService(overnight, 30, 6), true); // Sunday 00:30 -> Saturday tail
  assert.equal(isInService(overnight, 2 * 60, 6), false); // Sunday 02:00 -> past tail
  // No overnight extension -> 00:30 is not in service.
  const noNight = { ...overnight, last_train: ['23:30'] };
  assert.equal(isInService(noNight, 30, 6), false);
});
