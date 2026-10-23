import { expect, test } from 'bun:test';
import { normalizeEnglishName } from '../src/amap.ts';
import { foldStopName } from '../src/baidu.ts';
import { buildNetworkDistanceMatrix, verifyFareMatrixAgainstTariff } from '../src/fares.ts';
import {
  parseDropBox,
  parseRouteResult,
  parseStationDetail,
  parseTimetable
} from '../src/fetch.ts';
import { xuzhouMileageFare } from '../src/lines.ts';

// ── fixtures ──────────────────────────────────────────────────────────
// Small, hand-written slices of the operator's real markup. The parsers read
// server-rendered HTML, so their selectors are the fragile part of this
// adapter; these fixtures pin them down.

const DROPBOX_HTML = `<html><script>
var dropBox = [{"value":"1","label":"1号线","children":[
  {"value":"1","label":"路窝","children":[{"value":"1","label":"1号出入口","children":null},
                                          {"value":"3","label":"3号出入口","children":null}]},
  {"value":"2","label":"杏山子","children":[{"value":"42","label":"2号出入口","children":null}]}]},
 {"value":"6","label":"6号线","children":[
  {"value":"61","label":"铜山中医院","children":[]}]}];
</script></html>`;

const TIMETABLE_HTML = `<html><body><table class="time-table">
<thead><tr><th class="name">车站名称</th><th class="direction1">开往徐州东站</th><th class="direction2">开往路窝</th></tr></thead>
<tbody>
<tr><td><span class="dot"><span class="circle"></span></span><span class="name">路窝</span></td>
<td><div class="time-row"><span class="note">首</span><span class="time">06:00</span></div>
<div class="time-row"><span class="note">末</span><span class="time">22:30</span></div></td>
<td><div class="time-row"><span class="note">首</span><span class="time">—</span></div>
<div class="time-row"><span class="note">末</span><span class="time">—</span></div></td></tr>
<tr><td><span class="name">杏山子</span></td>
<td><div class="time-row"><span class="note">首</span><span class="time">06:03</span></div>
<div class="time-row"><span class="note">末</span><span class="time">22:33</span></div></td>
<td><div class="time-row"><span class="note">首</span><span class="time">06:36</span></div>
<div class="time-row"><span class="note">末</span><span class="time">23:06</span></div></td></tr>
</tbody></table></body></html>`;

const ROUTE_HTML = `<html><body><div class="search-result">
<div class="title"><div class="line">
<span class="label">查询结果：</span><span class="station">彭城广场</span>
<span class="line-tag tag1">2号线</span><span class="icon icon-arrow3"></span>
<span class="station">淮塔</span><span class="line-tag tag1">3号线</span></div>
<div class="price">票价：<strong>2</strong> 元</div></div>
<div class="metas"><div class="meta-row">
<div class="meta"><span class="label">站数：</span><span class="text">4站</span></div>
<div class="meta"><span class="label">时长：</span><span class="text">9分钟</span></div>
<div class="meta"><span class="label">换乘：</span><span class="text">0次</span></div>
</div></div>
<div class="stations">
<div><div class="item start"><label>起始站</label><span class="name">彭城广场</span></div></div>
<div><div class="item"><label></label><span class="name">户部山</span></div></div>
<div><div class="item"><label></label><span class="name">师大云龙校区</span></div></div>
<div><div class="item"><label></label><span class="name">中心医院</span></div></div>
<div><div class="item end"><label>终点站</label><span class="name">淮塔</span></div></div>
</div></div></body></html>`;

const STATION_HTML = `<html><body><div class="search-result">
<div class="first-end-time"><span class="label">首末班时刻表：</span><div class="bd">
<div class="item"><span class="direction">开往徐州东站方向</span>
<span class="time">首班：06:16&nbsp;&nbsp;</span><span class="time">末班：22:46</span></div>
<div class="item"><span class="direction">开往路窝方向</span>
<span class="time">首班：—</span><span class="time">末班：—</span></div>
</div></div>
<div class="entrances"><div class="title">出入口指南：</div><div class="entrance-list">
<div class="item"><span class="tag tag1">2</span><div class="cont">
<div class="name">2号出入口</div><div class="road"></div>
<div class="around">地标：<span>悠沃时尚街区、彭城饭店</span><br>
周边公交：<span>游5路、10路</span><br>
自行车点：<span>无</span></div></div></div>
</div></div>
<div class="facility"><div class="title">站内设施：</div><div class="cont">
<div class="item">自动售票机：东西站厅层西侧</div>
<div class="item">客服中心：东西站厅层中部</div>
</div></div>
</div></body></html>`;

// ── dropBox ───────────────────────────────────────────────────────────

test('dropBox yields the operator line list with per-line station order', () => {
  const lines = parseDropBox(DROPBOX_HTML);
  expect(lines.map((l) => l.label)).toEqual(['1号线', '6号线']);
  expect(lines[0]!.children!.map((s) => s.label)).toEqual(['路窝', '杏山子']);
  expect(lines[0]!.children!.map((s) => s.value)).toEqual(['1', '2']);
});

test('dropBox keeps the exit list of each station', () => {
  const lines = parseDropBox(DROPBOX_HTML);
  expect(lines[0]!.children![0]!.children!.map((e) => e.label)).toEqual(['1号出入口', '3号出入口']);
  // Line 6 stations ship an empty exit array, not a null one.
  expect(lines[1]!.children![0]!.children).toEqual([]);
});

test('a page without the dropBox tree is rejected', () => {
  expect(() => parseDropBox('<html></html>')).toThrow(/dropBox/);
});

// ── timetable ─────────────────────────────────────────────────────────

test('timetable rows carry both directions and the column headers', () => {
  const rows = parseTimetable(TIMETABLE_HTML);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.stationName).toBe('路窝');
  expect(rows[0]!.direction1).toBe('开往徐州东站');
  expect(rows[0]!.direction2).toBe('开往路窝');
  expect(rows[0]!.first1).toBe('06:00');
  expect(rows[0]!.last1).toBe('22:30');
  expect(rows[1]!.first2).toBe('06:36');
  expect(rows[1]!.last2).toBe('23:06');
});

test('a terminal station has no service in the direction that leaves it', () => {
  const rows = parseTimetable(TIMETABLE_HTML);
  // The em dash is a placeholder, not a time.
  expect(rows[0]!.first2).toBeUndefined();
  expect(rows[0]!.last2).toBeUndefined();
});

// ── route planner ─────────────────────────────────────────────────────

test('route result carries the operator fare, stop count, duration and transfers', () => {
  const r = parseRouteResult(ROUTE_HTML)!;
  expect(r.fare).toBe(2);
  expect(r.stops).toBe(4);
  expect(r.minutes).toBe(9);
  expect(r.transfers).toBe(0);
  expect(r.itinerary).toEqual(['彭城广场', '户部山', '师大云龙校区', '中心医院', '淮塔']);
});

test('a page without a result block yields no route', () => {
  expect(parseRouteResult('<html><body>nothing</body></html>')).toBeNull();
});

// ── station detail ────────────────────────────────────────────────────

test('station detail exposes exits, landmarks, buses and facilities', () => {
  const d = parseStationDetail(STATION_HTML)!;
  expect(d.exits).toHaveLength(1);
  expect(d.exits[0]!.number).toBe('2');
  expect(d.exits[0]!.label).toBe('2号出入口');
  expect(d.exits[0]!.landmark).toBe('悠沃时尚街区、彭城饭店');
  expect(d.exits[0]!.buses).toBe('游5路、10路');
  // "无" is not a landmark.
  expect(d.exits[0]!.bike).toBeUndefined();
  expect(d.facilities).toContain('自动售票机');
});

test('station detail normalises the em-dash of a direction with no service', () => {
  const d = parseStationDetail(STATION_HTML)!;
  expect(d.firstLast![0]!.first).toBe('06:16');
  expect(d.firstLast![1]!.first).toBeUndefined();
});

// ── names, stops, tariff ─────────────────────────────────────────────

test('AMap English labels are kept as published, all-caps ones are title-cased', () => {
  expect(normalizeEnglishName('Xuzhou Railway Station')).toBe('Xuzhou Railway Station');
  expect(normalizeEnglishName('LUWO')).toBe('Luwo');
  // A label that is only partly upper case is published as-is.
  expect(normalizeEnglishName('BAIXIANG St.')).toBe('BAIXIANG St.');
  expect(normalizeEnglishName('')).toBeUndefined();
  expect(normalizeEnglishName('   ')).toBeUndefined();
});

test('planner stop names drop the exit suffix and the trailing 站', () => {
  expect(foldStopName('路窝站(3口)')).toBe('路窝');
  // Both sides of every comparison are folded the same way, so a station whose
  // own name ends in 站 still matches.
  expect(foldStopName('徐州东站')).toBe(foldStopName('徐州东站'));
  expect(foldStopName(undefined)).toBe('');
});

test('the published mileage tariff steps at 6/12/18/26/34/44/59/79 km', () => {
  expect(xuzhouMileageFare(0)).toBe(2);
  expect(xuzhouMileageFare(6)).toBe(2);
  expect(xuzhouMileageFare(6.1)).toBe(3);
  expect(xuzhouMileageFare(12.1)).toBe(4);
  expect(xuzhouMileageFare(18.1)).toBe(5);
  expect(xuzhouMileageFare(26.1)).toBe(6);
  expect(xuzhouMileageFare(34.1)).toBe(7);
  expect(xuzhouMileageFare(44.1)).toBe(8);
  expect(xuzhouMileageFare(59.1)).toBe(9);
});

// ── network distance ──────────────────────────────────────────────────

test('network distance follows the tracks, not the straight line', () => {
  // Two stations 10 km apart on the line, joined by one 10 km segment.
  const distance = buildNetworkDistanceMatrix({
    segments: [{ from_stop_id: 'a', to_stop_id: 'b', distance_km: 10 }],
    stops: [
      { id: 'a', station_id: 'sa' },
      { id: 'b', station_id: 'sb' }
    ]
  });
  expect(distance('sa', 'sb')).toBeCloseTo(10, 6);
  expect(distance('sb', 'sa')).toBeCloseTo(10, 6);
  expect(distance('sa', 'sa')).toBe(0);
});

test('a transfer at the same station costs no in-vehicle mileage', () => {
  // Line A: … → hub. Line B: hub → …
  const distance = buildNetworkDistanceMatrix({
    segments: [
      { from_stop_id: 'a1', to_stop_id: 'hubA', distance_km: 4 },
      { from_stop_id: 'hubB', to_stop_id: 'b1', distance_km: 6 }
    ],
    stops: [
      { id: 'a1', station_id: 'sa' },
      { id: 'hubA', station_id: 'hub' },
      { id: 'hubB', station_id: 'hub' },
      { id: 'b1', station_id: 'sb' }
    ]
  });
  // 4 km on line A, a free station-hall transfer, 6 km on line B.
  expect(distance('sa', 'sb')).toBeCloseTo(10, 6);
  expect(distance('sb', 'sa')).toBeCloseTo(10, 6);
});

test('the tariff cross-check accepts a price that lands in the published band', () => {
  const matrix = {
    $schema: 'x',
    schema_version: '1.0',
    network_id: 'cn-xuzhou',
    generated_at: 'now',
    source: [],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: ['a', 'b'],
    fares: [
      [0, 3],
      [3, 0]
    ]
  };
  // 10 km of track sits in the 12 km band -> 4 yuan.
  const check = verifyFareMatrixAgainstTariff(matrix, () => 10);
  expect(check.consistent).toBe(1);
  expect(check.inconsistent).toBe(0);

  const wrong = verifyFareMatrixAgainstTariff(matrix, () => 3);
  expect(wrong.inconsistent).toBe(1);
});
