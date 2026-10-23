import { expect, test } from 'bun:test';
import { parseOfficialStops } from '../src/fetch.ts';
import { foldGuiyangStationName, guiyangStationName } from '../src/names.ts';
import { isMetroLineName, parseDirection, parsePlannerResponse } from '../src/planner.ts';

test('station names fold to the canonical operator name', () => {
  // The operator's page appends 站 to some stops and not to others.
  expect(guiyangStationName('窦官站')).toBe('窦官');
  expect(guiyangStationName('小孟工业园站')).toBe('小孟工业园');
  expect(guiyangStationName('白云北路站')).toBe('白云北路');
  expect(guiyangStationName('中兴路站')).toBe('中兴路');
  // A real station name that ends in 站 keeps it.
  expect(guiyangStationName('贵阳北站')).toBe('贵阳北站');
  expect(guiyangStationName('贵阳火车站')).toBe('贵阳火车站');
  expect(guiyangStationName('花溪南站')).toBe('花溪南站');
  // Full-width parentheses become half-width.
  expect(guiyangStationName('东风（贵黔医院）')).toBe('东风(贵黔医院)');
  expect(guiyangStationName('桐木岭（省委党校）')).toBe('桐木岭(省委党校)');
  // A genuine name alias survives.
  expect(guiyangStationName('四方河(省中医院)')).toBe('四方河(省中医院)');
  // The planner appends the exit it picked.
  expect(guiyangStationName('北京路站(C口)')).toBe('北京路');
  expect(guiyangStationName('龙洞堡机场站(A2口)')).toBe('龙洞堡机场');
  expect(guiyangStationName('天河潭站(A1口)')).toBe('天河潭');
  expect(guiyangStationName('大科城站(D口)')).toBe('大科城');
});

test("the operator's mislabelled station is corrected to 小碧", () => {
  // The planner database calls 2 号线's 小碧站 "多彩贵州城"; the network map,
  // the operator's own 2025-08-29 announcement and Baidu all say 小碧.
  expect(guiyangStationName('多彩贵州城')).toBe('小碧');
  // The planner spells it with the 站 suffix as well.
  expect(guiyangStationName('多彩贵州城站')).toBe('小碧');
  // The fold keeps both spellings apart so AMap lookups stay exact.
  expect(foldGuiyangStationName('多彩贵州城')).toBe('多彩贵州城');
  expect(foldGuiyangStationName('小碧')).toBe('小碧');
});

test('the direction label survives a parenthesised terminal', () => {
  expect(
    parseDirection('洛湾站乘轨道交通3号线(桐木岭(省委党校)方向)经过28站到桐木岭(省委党校)站')
  ).toBe('桐木岭(省委党校)');
  expect(parseDirection('望城坡站乘轨道交通1号线(小孟工业园方向)经过3站到清水江路站')).toBe(
    '小孟工业园'
  );
  expect(parseDirection('皂角坝站乘轨道交通S1线(望城坡方向)经过12站到望城坡站')).toBe('望城坡');
  expect(parseDirection(undefined)).toBeUndefined();
});

test('metro line labels are recognised', () => {
  expect(isMetroLineName('轨道交通3号线')).toBe(true);
  expect(isMetroLineName('轨道交通S1线')).toBe(true);
  expect(isMetroLineName('花溪9路')).toBe(false);
  expect(isMetroLineName(undefined)).toBe(false);
});

test('a planner response separates ride legs from walking legs', () => {
  const plan = parsePlannerResponse({
    code: 0,
    msg: '获取成功',
    data: {
      duration: '29分钟',
      distance: 14024,
      price: 5,
      list: [
        {
          name: '轨道交通1号线',
          instructions: '喷水池站乘轨道交通1号线(窦官方向)经过1站到北京路站',
          duration: '2分钟',
          distance: 950,
          firstTime: '06:31',
          lastTime: '23:20',
          stopNum: 1,
          onStation: '喷水池站',
          offStation: '北京路站',
          stopInfo: [{ stop_name: '北京路站', stop_location: { lat: 26.59859, lng: 106.712944 } }]
        },
        {
          name: '',
          instructions: '站厅换乘 步行72米',
          duration: '0分钟',
          distance: 72
        }
      ]
    }
  });

  expect(plan).toBeDefined();
  expect(plan?.durationMinutes).toBe(29);
  expect(plan?.distanceMeters).toBe(14024);
  expect(plan?.price).toBe(5);
  expect(plan?.metroOnly).toBe(true);
  expect(plan?.legs).toHaveLength(2);

  const ride = plan?.legs[0];
  expect(ride).toBeDefined();
  expect(ride?.isWalk).toBe(false);
  expect(ride?.onStation).toBe('喷水池');
  expect(ride?.offStation).toBe('北京路');
  expect(ride?.firstTime).toBe('06:31');
  expect(ride?.lastTime).toBe('23:20');
  expect(ride?.durationMinutes).toBe(2);
  expect(ride?.distanceMeters).toBe(950);
  expect(ride?.stops[0]?.canonicalName).toBe('北京路');
  expect(ride?.stops[0]?.lat).toBe(26.59859);

  const walk = plan?.legs[1];
  expect(walk?.isWalk).toBe(true);
  expect(walk?.distanceMeters).toBe(72);
  expect(walk?.instructions).toBe('站厅换乘 步行72米');
});

test('a bus-only plan is not a metro plan', () => {
  const plan = parsePlannerResponse({
    code: 0,
    data: {
      duration: '58分钟',
      distance: 19688,
      price: -1,
      list: [
        { name: '', instructions: '步行968米', duration: '5分钟', distance: 968 },
        {
          name: '花溪9路',
          instructions: '一八三厂路口站乘花溪9路(花溪车站方向)经过6站到轨道中曹司站',
          duration: '20分钟',
          distance: 4480
        }
      ]
    }
  });
  expect(plan?.metroOnly).toBe(false);
  expect(plan?.price).toBe(-1);
});

test('a rejected query parses to undefined', () => {
  expect(parsePlannerResponse({ code: 1, msg: '参数有误' })).toBeUndefined();
  expect(parsePlannerResponse(undefined)).toBeUndefined();
});

test('the official station list is parsed from the inquiry page', () => {
  const html = `
    <ul class="select-ul">
      <li class="option option1">
        <p class="option-p"><span class="option-span span1">1号线</span>窦官站—小孟工业园站</p>
        <ul class="subwayList1 subwayList" id="">
          <p class="subwayList-p"><span class="subwayList-span span1">1号线</span>窦官站—小孟工业园站</p>
          <li class="list" index_number="1" index_origin="26.659702,106.575773">窦官站</li>
          <li class="list" index_number="1" index_origin="26.661715,106.5863">下麦西</li>
          <li class="" index_number="1" index_origin="26.654356,106.59675">老湾塘</li>
        </ul>
      </li>
      <li class="option option2">
        <ul class="subwayList2 subwayList number_3">
          <li class="list" index_number="3" index_origin="26.643623,106.82584">东风（贵黔医院）</li>
        </ul>
      </li>
    </ul>`;

  const stops = parseOfficialStops(html);
  expect(stops).toHaveLength(4);
  expect(stops[0]).toEqual({ lineId: '1', name: '窦官站', coord: '26.659702,106.575773' });
  expect(stops[2]?.name).toBe('老湾塘');
  expect(stops[3]).toEqual({
    lineId: '3',
    name: '东风（贵黔医院）',
    coord: '26.643623,106.82584'
  });
});

test('the destination picker copy is not parsed twice', () => {
  // The page renders the list twice (origin + destination picker); the
  // destination copy carries `index_destination`, not `index_origin`.
  const html = `
    <li class="list" index_number="1" index_origin="26.659702,106.575773">窦官站</li>
    <li class="list" index_number="1" index_destination="26.659702,106.575773">窦官站</li>
    <li class="list" index_number="S1" index_origin="">望城坡</li>`;
  const stops = parseOfficialStops(html);
  expect(stops).toHaveLength(1);
  expect(stops[0]?.name).toBe('窦官站');
});
