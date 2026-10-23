import { expect, test } from 'bun:test';
import { fareSpec } from '../src/fares.ts';
import type { AmapSubwayDoc, NbLineRecord, NbStationRecord } from '../src/fetch.ts';
import { normalizeNingbo } from '../src/normalize.ts';

/**
 * A miniature copy of the operator's `station.php?stat` feed.
 *
 * The real feed has one entry per line, each station carrying the official
 * station id (shared by every line the station belongs to), the interchange
 * flag `intro` and the two directions' service windows.
 */
function station(
  id: string,
  title: string,
  fx1: string | null,
  fx2: string | null,
  intro: string | null = null,
  withService = true
): NbStationRecord {
  return {
    id,
    title,
    intro,
    fx1,
    fx2,
    sbc1: withService ? '06:00' : null,
    mbc1: withService ? '22:00' : null,
    sbc2: withService ? '06:10' : null,
    mbc2: withService ? '22:10' : null,
    dfx1: null,
    dfx2: null,
    dsbc1: null,
    dmbc1: null,
    dsbc2: null,
    dmbc2: null,
    type: null
  };
}

const LINE_1: NbLineRecord = {
  type: '1',
  station: [
    // The feed spells the eastern terminus 小洋红 in its direction label while
    // the station itself is 小洋江 — the adapter has to fold the typo back.
    station('101', '高桥西', '小洋红', '小洋红'),
    station('102', '中心广场', '小洋红', '高桥西', '1'),
    station('103', '小洋江', '高桥西', '高桥西')
  ]
};

const LINE_2: NbLineRecord = {
  type: '2',
  station: [
    station('102', '中心广场', '外滩大桥', '外滩大桥', '1'),
    station('104', '外滩大桥', '中心广场', '中心广场'),
    // Listed on Line 2, but the operator publishes no service there and the
    // network map notes 「暂不能换乘」 — so it is not a Line 2 stop.
    station('105', '未开通站', '外滩大桥', '外滩大桥', null, false)
  ]
};

const AMAP: AmapSubwayDoc = {
  s: '宁波',
  i: '330200',
  l: [
    {
      ln: '轨道交通1号线',
      kn: '轨道交通1号线',
      cl: '#0072BC',
      ek: 'Line 1',
      li: '1',
      st: [
        { n: '高桥西', en: 'Gaoqiao West', sp: 'GaoQiao Xi', sl: '121.5,29.9', p: '10 20' },
        { n: '中心广场', en: 'Zhongxin Square', sp: 'ZhongXin GuangChang', sl: '121.52,29.87' },
        { n: '小洋江', en: 'Xiaoyangjiang', sp: 'XiaoYang Jiang', sl: '121.55,29.85' }
      ]
    },
    {
      ln: '轨道交通2号线',
      kn: '轨道交通2号线',
      cl: '#E3002D',
      ek: 'Line 2',
      li: '2',
      st: [
        { n: '中心广场', en: 'Zhongxin Square', sp: 'ZhongXin GuangChang', sl: '121.52,29.87' },
        { n: '外滩大桥', en: 'Waitan Bridge', sp: 'WaiTan DaQiao', sl: '121.54,29.89' },
        { n: '未开通站', en: '', sp: 'WeiKaiTong Zhan', sl: '121.56,29.83' }
      ]
    }
  ]
};

const canonical = normalizeNingbo({ official: [LINE_1, LINE_2], amapSubway: AMAP });

test('the lines keep the operator numbering and their published English name', () => {
  expect(canonical.lines.map((l) => l.id)).toEqual(['cn-ningbo-line-1', 'cn-ningbo-line-2']);
  expect(canonical.lines[0]?.names).toEqual({ zh: '1号线', en: 'Line 1' });
  expect(canonical.lines[0]?.color).toBe('#0072bc');
  expect(canonical.lines[0]?.mode).toBe('metro');
});

test('a station served by two lines is one physical station', () => {
  const zhongxin = canonical.stations.filter((s) => s.names?.zh === '中心广场');
  expect(zhongxin.length).toBe(1);
  expect(zhongxin[0]?.extras?.lines).toEqual(['1', '2']);
  expect(zhongxin[0]?.extras?.is_interchange).toBe(true);
  // The AMap coordinate is carried over in the canonical datum.
  expect(zhongxin[0]?.location?.lon).toBeCloseTo(121.52, 6);
  expect(zhongxin[0]?.location?.crs).toBe('gcj02');
});

test('a station without published service is not a stop on that line', () => {
  const stopped = canonical.stops.filter((s) => s.station_id.includes('未开通站'));
  expect(stopped.length).toBe(0);
  const station = canonical.stations.find((s) => s.names?.zh === '未开通站');
  expect(station?.extras?.lines_listed_without_service).toEqual(['2']);
});

test('the topology yields one pattern and one segment per adjacent pair', () => {
  const line1 = canonical.patterns.filter((p) => p.line_id === 'cn-ningbo-line-1');
  expect(line1.length).toBe(1);
  expect(line1[0]?.stop_ids.length).toBe(3);
  expect(canonical.segments.filter((s) => s.line_id === 'cn-ningbo-line-1').length).toBe(2);
  expect(canonical.segments.filter((s) => s.line_id === 'cn-ningbo-line-2').length).toBe(1);
});

test('an interchange gets the full directional pair set', () => {
  const station = canonical.stations.find((s) => s.names?.zh === '中心广场')!;
  expect(canonical.interchangePairs.has(`${station.id}|cn-ningbo-line-1|cn-ningbo-line-2`)).toBe(
    true
  );
  expect(canonical.interchangePairs.has(`${station.id}|cn-ningbo-line-2|cn-ningbo-line-1`)).toBe(
    true
  );
  expect(canonical.pendingInterchanges.size).toBe(0);
});

test('the direction labels are resolved onto the station names', () => {
  const zhongxin = canonical.stations.find((s) => s.names?.zh === '中心广场')!;
  const xiaoyangjiang = canonical.stations.find((s) => s.names?.zh === '小洋江')!;
  const stop = canonical.stops.find(
    (s) => s.station_id === xiaoyangjiang.id && s.line_id === 'cn-ningbo-line-1'
  )!;
  const toXiaoYangjiang = canonical.timetables.find(
    (t) =>
      t.station_id === zhongxin.id &&
      t.line_id === 'cn-ningbo-line-1' &&
      t.extras?.dest_name === '小洋江'
  );
  // The feed writes 小洋红, a typo for 小洋江 — the timetable must point at the
  // station that exists.
  expect(toXiaoYangjiang?.destination_stop_id).toBe(stop.id);
  expect(toXiaoYangjiang?.extras?.dest_name).toBe('小洋江');
});

test('the service window is carried as published', () => {
  const zhongxin = canonical.stations.find((s) => s.names?.zh === '中心广场')!;
  const tt = canonical.timetables.find(
    (t) =>
      t.station_id === zhongxin.id &&
      t.line_id === 'cn-ningbo-line-1' &&
      t.extras?.dest_name === '高桥西'
  );
  expect(tt?.first_train).toEqual(['06:10']);
  expect(tt?.last_train).toEqual(['22:10']);
  expect(tt?.direction_label).toBe('往高桥西方向');
  expect(tt?.extras?.direction_index).toBe(2);
});

test('the official fare query is keyed by the operator station id', () => {
  const station = canonical.stations.find((s) => s.names?.zh === '中心广场')!;
  expect(fareSpec.keyOf(station as never, () => undefined as never)).toBe('102');
  expect(fareSpec.networkId).toBe('cn-ningbo');
  expect(fareSpec.unit).toBe('yuan');
});
