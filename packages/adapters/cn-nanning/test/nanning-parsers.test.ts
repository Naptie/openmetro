import { expect, test } from 'bun:test';
import type { BaiduStationRef } from '../../core/src/index.js';
import { buildRailAdjacency, minRailDistanceKm } from '../src/fares.ts';
import {
  parseNetworkMapImage,
  parseOfficialLines,
  parseOfficialStationDetails,
  parseTimetableImages
} from '../src/fetch.ts';
import {
  ENGLISH_NAME_OVERRIDES,
  nanningFareUpperBound,
  nanningMileageFare,
  PLANNED_STATIONS,
  plannerStopMatches
} from '../src/lines.ts';
import { englishNameFor } from '../src/normalize.ts';
import { destinationPool, serviceBandFor } from '../src/timetables.ts';

// ---------------------------------------------------------------------------
// The operator's page markup
// ---------------------------------------------------------------------------

const LINE_BLOCK = `
<div class="tran-tag-li-3-main-bottom-li">
  <div class="tran-tag-li-3-main-bottom-li-top">轨道交通1号线</div>
  <div class="tran-tag-li-3-main-bottom-li-desc">
    <span>火车东站</span><img src="/img/icon/tran-iocn-r.png" alt=""><span>石埠</span>
  </div>
  <div class="tran-tag-li-3-main-bottom-li-line-li" data-id="subway-site-info-663079288516677">
    <span>火车东站</span>
  </div>
  <div class="tran-tag-li-3-main-bottom-li-line-li" data-id="subway-site-info-663079288520773">
    <span>佛子岭</span>
  </div>
</div>`;

const STATION_BLOCK = `
<div class="li-3-main-bottom-con-li-l">
  <div class="li-3-main-bottom-con-li-l-top">服务设施(火车东站)</div>
  <div class="li-3-main-bottom-con-li-l-bottom">
    <p><img src="https://www.nngdjt.com/resources/image/2025/07/21/700113609154629.jpg" class="art-body-img" /></p>
  </div>
</div>
<div class="li-3-main-bottom-con-li-l">
  <div class="li-3-main-bottom-con-li-l-top">站点出入口信息(火车东站)</div>
  <div class="li-3-main-bottom-con-li-l-bottom">
    <p>A口：铁路南进站口 南广场 站南西路</p>
    <p>B口：通达西路 枫林路 南出租车</p>
  </div>
</div>
<div class="li-3-main-bottom-con-li-r">
  <div class="li-3-main-bottom-con-li-l-top-r">站点信息(火车东站)</div>
  <div class="li-3-main-bottom-con-li-l-bottom">
    <p>火车东站是南宁轨道交通1号线的终点站，车站位于铁路火车东站南广场下方。</p>
  </div>
</div>
<div class="li-3-main-bottom-con-li-l">
  <div class="li-3-main-bottom-con-li-l-top">换乘信息(金湖广场)</div>
  <div class="li-3-main-bottom-con-li-l-bottom">
    <p><span>1号线换乘3号线</span>：通过站厅通道直接换乘，无需出站。</p>
  </div>
</div>
<!-- <img src="" alt=""> -->`;

test('the official line block yields the line, its terminals and its stops', () => {
  const lines = parseOfficialLines(LINE_BLOCK);
  expect(lines).toHaveLength(1);
  expect(lines[0]!.officialId).toBe('1');
  expect(lines[0]!.name).toBe('轨道交通1号线');
  expect(lines[0]!.terminals).toEqual(['火车东站', '石埠']);
  expect(lines[0]!.stops.map((s) => s.name)).toEqual(['火车东站', '佛子岭']);
  expect(lines[0]!.stops[0]!.officialId).toBe('663079288516677');
});

test('the station blocks yield the exits, the description and the transfer note', () => {
  const details = parseOfficialStationDetails(STATION_BLOCK);
  const huoche = details.get('火车东站');
  expect(huoche?.exits.map((e) => e.exit)).toEqual(['A口', 'B口']);
  expect(huoche?.exits[0]?.landmarks).toEqual(['铁路南进站口', '南广场', '站南西路']);
  expect(huoche?.description).toContain('终点站');
  expect(huoche?.facilitiesImage).toContain('700113609154629.jpg');

  const jinhu = details.get('金湖广场');
  expect(jinhu?.transferNote).toContain('通过站厅通道直接换乘');
  // Commented-out markup must not leak into the note.
  expect(jinhu?.transferNote).not.toContain('-->');
  expect(jinhu?.transferNote).not.toContain('<');
});

test('the timetable sheets and the network map are read from the page', () => {
  const html = `
    <div class="won-tran-tag-li-1-con image-view"><img src="https://example.test/map.png" /></div>
    <div class="subway-schedule-table"><img src="https://example.test/l1.png" /></div>
    <div class="subway-schedule-table"><img src="https://example.test/l2.png" /></div>`;
  expect(parseNetworkMapImage(html)).toBe('https://example.test/map.png');
  expect(parseTimetableImages(html)).toEqual([
    'https://example.test/l1.png',
    'https://example.test/l2.png'
  ]);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('AMap pinyin labels are title-cased, real acronyms are kept', () => {
  expect(englishNameFor({ multilang: { n: { en: 'FOZILING' } }, sp: 'FoZiLing' })).toBe('Foziling');
  expect(englishNameFor({ multilang: { n: { en: 'JINHU Square' } }, sp: 'JinHu GuangChang' })).toBe(
    'Jinhu Square'
  );
  expect(
    englishNameFor({
      multilang: { n: { en: 'ASEAN Business District' } },
      sp: 'DongMeng ShangWuQu'
    })
  ).toBe('ASEAN Business District');
  expect(
    englishNameFor({
      multilang: { n: { en: 'Nanning East Railway Station' } },
      sp: 'HuoChe DongZhan'
    })
  ).toBe('Nanning East Railway Station');
  expect(englishNameFor(undefined)).toBe('');
});

test('the planned station has an English name of its own', () => {
  expect(ENGLISH_NAME_OVERRIDES.五象火车站).toBe('Wuxiang Railway Station');
  expect(PLANNED_STATIONS.map((p) => p.name)).toEqual(['五象火车站']);
});

test('the planner stop names are folded onto the operator spelling', () => {
  expect(plannerStopMatches('会展中心站(C口)', '会展中心')).toBe(true);
  expect(plannerStopMatches('火车东站', '火车东站')).toBe(true);
  expect(plannerStopMatches('会展中心站(C口)', '佛子岭')).toBe(false);
  expect(plannerStopMatches(undefined, '会展中心')).toBe(false);
});

// ---------------------------------------------------------------------------
// The published tariff
// ---------------------------------------------------------------------------

test('the mileage tariff follows the published ladder', () => {
  expect(nanningMileageFare(0)).toBe(2);
  expect(nanningMileageFare(6)).toBe(2);
  expect(nanningMileageFare(6.1)).toBe(3);
  expect(nanningMileageFare(12)).toBe(3);
  expect(nanningMileageFare(18)).toBe(4);
  expect(nanningMileageFare(26)).toBe(5);
  expect(nanningMileageFare(34)).toBe(6);
  expect(nanningMileageFare(40)).toBe(7);
  expect(nanningMileageFare(44)).toBe(7);
  expect(nanningMileageFare(44.1)).toBe(8);
});

test('a planner quote may sit one ladder step below the polyline distance', () => {
  // The operator prices on its own ride distance, which is a little shorter
  // than the planner's polyline — so a quote is at most one step above the
  // ladder applied to that polyline.
  expect(nanningFareUpperBound(20)).toBe(nanningMileageFare(20) + 1);
  expect(nanningFareUpperBound(2)).toBe(nanningMileageFare(2) + 1);
});

// ---------------------------------------------------------------------------
// Harvest helpers
// ---------------------------------------------------------------------------

const refs: BaiduStationRef[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({
  name,
  lon: 108.3,
  lat: 22.8
}));

test('the destination pool stays inside the direction of travel', () => {
  // Toward the last stop of the line — the far terminus first, because the
  // planner answers a long ride reliably.
  const down = destinationPool(refs, 2, 'down').map((r) => r.name);
  expect(down[0]).toBe('F');
  expect(down).toContain('D');
  expect(down).not.toContain('A');
  expect(down).not.toContain('B');

  // Toward the first stop of the line.
  const up = destinationPool(refs, 2, 'up').map((r) => r.name);
  expect(up[0]).toBe('A');
  expect(up).toContain('B');
  expect(up).not.toContain('E');
  expect(up).not.toContain('F');
});

test('the service band follows the operator two-band split', () => {
  // 2026-10-23 is a Friday → 周五–周六 band.
  expect(serviceBandFor(new Date('2026-10-23T12:00:00Z'))).toBe('fri_weekend');
  expect(serviceBandFor(new Date('2026-10-26T12:00:00Z'))).toBe('mon_thu');
  expect(serviceBandFor(new Date('2026-10-25T12:00:00Z'))).toBe('fri_weekend');
});

// ---------------------------------------------------------------------------
// Fare fallback
// ---------------------------------------------------------------------------

test('the shortest rail distance ignores the line change', () => {
  // Two lines sharing a station; the transfer is free.
  const ids = ['a', 'b', 'c', 'x', 'y'];
  const segments = [
    { from_station_id: 'a', to_station_id: 'b', distance_km: 1 },
    { from_station_id: 'b', to_station_id: 'c', distance_km: 1 },
    { from_station_id: 'c', to_station_id: 'x', distance_km: 1 },
    { from_station_id: 'x', to_station_id: 'y', distance_km: 5 }
  ];
  const adj = buildRailAdjacency(ids, segments);
  const dist = minRailDistanceKm(ids.indexOf('a'), ids, adj);
  expect(dist[ids.indexOf('b')]).toBeCloseTo(1);
  expect(dist[ids.indexOf('c')]).toBeCloseTo(2);
  expect(dist[ids.indexOf('x')]).toBeCloseTo(3);
  expect(dist[ids.indexOf('y')]).toBeCloseTo(8);
});
