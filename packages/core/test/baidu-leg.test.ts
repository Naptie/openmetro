import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchBaiduSubwayLeg, lastDepartureFromArrival } from '../src/gapfill/timetables.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const station = { name: 'A', lon: 116.9, lat: 36.6 };

test('fetchBaiduSubwayLeg prefers the hinted line across routes', async () => {
  const metroLeg = {
    type: 1,
    name: '地铁1号线',
    start_info: { start_time: '06:00' },
    end_info: { end_time: '22:00' },
    stop_info: [{ stop_name: 'B' }]
  };
  const yunbaLeg = {
    type: 1,
    name: '云巴1号线外环',
    direct_text: '大正路方向',
    start_info: { start_time: '06:10' },
    end_info: { end_time: '21:58' },
    stop_info: [{ stop_name: 'C' }, { stop_name: 'D' }]
  };
  // Route 0 leads with the metro leg; the SkyShuttle leg only appears later.
  globalThis.fetch = (async () =>
    jsonResponse({
      status: 0,
      result: {
        routes: [
          {
            steps: [[{ vehicle: metroLeg, duration: 300 }], [{ vehicle: yunbaLeg, duration: 240 }]]
          }
        ]
      }
    })) as typeof fetch;

  const hinted = await fetchBaiduSubwayLeg('ak', station, station, { lineNameHint: '云巴' });
  assert.equal(hinted?.lineName, '云巴1号线外环');
  assert.equal(hinted?.firstDeparture, '06:10');
  assert.deepEqual(hinted?.stopNames, ['C', 'D']);

  const unhinted = await fetchBaiduSubwayLeg('ak', station, station);
  assert.equal(unhinted?.lineName, '地铁1号线');
});

test('fetchBaiduSubwayLeg returns null with an unmet hint instead of a foreign leg', async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      status: 0,
      result: {
        routes: [{ steps: [[{ vehicle: { type: 1, name: '地铁2号线' }, duration: 300 }]] }]
      }
    })) as typeof fetch;

  const leg = await fetchBaiduSubwayLeg('ak', station, station, { lineNameHint: '云巴' });
  assert.equal(leg, null);
});

test('lastDepartureFromArrival floors sub-minute durations to a parseable HH:MM', () => {
  // 2807s = 46m47s → 20:00 − 46m47s floors to 19:13, never "19:13.2166…".
  assert.equal(lastDepartureFromArrival('20:00', '08:00', 2807), '19:13');
  assert.equal(lastDepartureFromArrival('23:00', '06:00', 129), '22:57');
  // Whole-minute durations are unchanged.
  assert.equal(lastDepartureFromArrival('20:00', '08:00', 2640), '19:16');
  // After-midnight chains stay on the service day.
  assert.equal(lastDepartureFromArrival('00:30', '23:00', 2400), '23:50');
  assert.equal(lastDepartureFromArrival('20:00', '08:00', null), null);
});
