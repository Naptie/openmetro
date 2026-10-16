import {
  foldStationName,
  hexToCss,
  isUsableEnglish,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  parsePixel,
  parseSlCoord,
  pinyinToEnglish,
  placeholderCity,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import { AMAP_URL, type DongguanSources } from './fetch.js';
import { parseTimetableArticle } from './timetables.js';

export const NETWORK_ID = 'cn-dongguan';

export function normalizeDongguan(input: DongguanSources) {
  const sections = parseTimetableArticle(input.timetableHtml);
  const stationsByName = new Map<string, StationEncoded>();
  const lines: LineEncoded[] = [];
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];

  for (const short of ['1', '2']) {
    const weekday = sections.find((s) => s.line === short && s.calendar === 'weekday')!;
    const weekend = sections.find((s) => s.line === short && s.calendar === 'weekend')!;
    if (
      weekday.rows.length !== weekend.rows.length ||
      weekday.rows.some(
        (r, i) => foldStationName(r.station) !== foldStationName(weekend.rows[i]!.station)
      ) ||
      weekday.destinations.some(
        (d, i) => foldStationName(d) !== foldStationName(weekend.destinations[i]!)
      )
    ) {
      throw new Error(`Line ${short}: weekday/weekend topology disagrees`);
    }
    const amap = input.amap.l.find((l) => l.ln === `${short}号线`);
    if (!amap || amap.st.length !== weekday.rows.length)
      throw new Error(`Line ${short}: AMap topology is stale`);
    const byName = new Map(amap.st.map((s) => [foldStationName(s.n), s]));
    const lineId = `${NETWORK_ID}-line-${short}`;
    const patternId = `${NETWORK_ID}-pattern-${short}-primary`;
    const lineStops: StopEncoded[] = [];

    lines.push({
      id: lineId,
      name: `${short}号线`,
      names: { zh: `${short}号线`, en: `Line ${short}` },
      short_name: short,
      aliases: [],
      color: hexToCss(amap.cl),
      mode: 'metro',
      status: 'operating',
      loop: false,
      source_ids: [
        { source: input.timetableUrl, id: short },
        { source: AMAP_URL, id: amap.li ?? short }
      ],
      extras: { names_source: 'source' }
    });

    for (let i = 0; i < weekday.rows.length; i++) {
      const row = weekday.rows[i]!;
      const key = foldStationName(row.station);
      const a = byName.get(key);
      if (!a) throw new Error(`Line ${short}: no AMap match for ${row.station}`);
      let station = stationsByName.get(key);
      if (!station) {
        const sourceEnglish = a.multilang?.n?.en;
        const en = isUsableEnglish(sourceEnglish) ? sourceEnglish! : pinyinToEnglish(a.sp);
        const location = parseSlCoord(a.sl);
        if (
          !en ||
          !location ||
          location.lon < 113.4 ||
          location.lon > 114.6 ||
          location.lat < 22.5 ||
          location.lat > 23.4
        ) {
          throw new Error(`Invalid name/coordinate for ${row.station}`);
        }
        const pixel = parsePixel(a.p);
        const sourceId = a.poiid ?? a.si;
        if (!sourceId) throw new Error(`Missing AMap station identity for ${row.station}`);
        station = {
          id: `${NETWORK_ID}-${sourceId.toLowerCase()}`,
          name: a.n,
          names: { zh: a.n, en },
          status: 'operating',
          location: { ...location, crs: 'gcj02' },
          schematic: pixel ? { ...pixel, crs: 'schematic' } : undefined,
          source_ids: [{ source: AMAP_URL, id: sourceId }],
          extras: {
            location_source: 'subway',
            location_provider: 'amap_subway',
            names_source: sourceEnglish ? 'source' : 'derived'
          }
        };
        stationsByName.set(key, station);
      }
      const pixel = parsePixel(a.p);
      const stop: StopEncoded = {
        id: `${station.id}-${short}`,
        station_id: station.id,
        line_id: lineId,
        sequence: i,
        is_terminal: i === 0 || i === weekday.rows.length - 1,
        source_id: a.si ?? a.n,
        schematic: pixel ? { ...pixel, crs: 'schematic' } : undefined
      };
      lineStops.push(stop);
      stops.push(stop);
    }
    if (new Set(lineStops.map((s) => s.id)).size !== lineStops.length)
      throw new Error(`Line ${short}: repeated stop`);
    const origin = lineStops[0]!;
    const terminal = lineStops[lineStops.length - 1]!;
    patterns.push({
      id: patternId,
      line_id: lineId,
      name: `${weekday.rows[0]!.station} → ${weekday.rows.at(-1)!.station}`,
      names: {
        zh: `${weekday.rows[0]!.station} → ${weekday.rows.at(-1)!.station}`,
        en: `${stationsByName.get(foldStationName(weekday.rows[0]!.station))!.names.en} to ${stationsByName.get(foldStationName(weekday.rows.at(-1)!.station))!.names.en}`
      },
      stop_ids: lineStops.map((s) => s.id),
      origin_stop_id: origin.id,
      terminal_stop_id: terminal.id,
      is_primary: true,
      source_ids: [{ source: input.timetableUrl, id: short }]
    });
    for (let i = 0; i < lineStops.length - 1; i++) {
      const a = lineStops[i]!;
      const b = lineStops[i + 1]!;
      segments.push({
        id: `${lineId}-segment-${i}`,
        line_id: lineId,
        from_stop_id: a.id,
        to_stop_id: b.id,
        from_station_id: a.station_id,
        to_station_id: b.station_id,
        direction: 'both',
        source_id: input.timetableUrl
      });
    }

    for (const side of [0, 1] as const) {
      const destinationName = foldStationName(weekday.destinations[side]);
      const destIndex = weekday.rows.findIndex(
        (r) => foldStationName(r.station) === destinationName
      );
      if (destIndex !== 0 && destIndex !== lineStops.length - 1)
        throw new Error(`Line ${short}: non-terminal destination`);
      const destination = lineStops[destIndex]!;
      for (let i = 0; i < lineStops.length; i++) {
        const stop = lineStops[i]!;
        const w = weekday.rows[i]!;
        const e = weekend.rows[i]!;
        const values = [w.first[side], w.last[side], e.first[side], e.last[side]];
        if (stop.id === destination.id) {
          if (values.some((v) => v != null))
            throw new Error(`Line ${short}: terminal has an outgoing timetable to itself`);
          continue;
        }
        if (values.some((v) => v == null))
          throw new Error(`Line ${short}: incomplete times for ${w.station}`);
        const week = (work: string | null, rest: string | null) => [
          work!,
          work!,
          work!,
          work!,
          work!,
          rest!,
          rest!
        ];
        timetables.push({
          id: `${stop.id}-to-${destination.id}`,
          station_id: stop.station_id,
          stop_id: stop.id,
          line_id: lineId,
          source_id: input.timetableUrl,
          pattern_id: patternId,
          destination_stop_id: destination.id,
          origin_stop_id: destination.id === origin.id ? terminal.id : origin.id,
          direction_type: 'linear',
          direction_label: `往${weekday.destinations[side]}`,
          first_train: week(w.first[side], e.first[side]),
          last_train: week(w.last[side], e.last[side]),
          extras: {
            calendar: 'weekday_weekend',
            calendar_note:
              'Mon–Fri workday / Sat–Sun non-workday baseline; statutory holidays and compensating workdays follow operator notices.'
          }
        });
      }
    }
  }
  const stations = [...stationsByName.values()];
  if (new Set(stations.map((s) => s.id)).size !== stations.length)
    throw new Error('Station id collision');
  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '东莞轨道交通',
    names: { zh: '东莞轨道交通', en: 'Dongguan Rail Transit' },
    city: placeholderCity('CN-4419'),
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '官网常规首末班车；高德坐标、名称及示意图。调休与临时延时以公告为准。区间时间优先由末班车推导，距离为直线估计；未补齐的换乘时间采用120秒。票价为官网查询支持的基本票价，不含优惠；未支持的OD为null。'
  };
  return { network, lines, stations, stops, patterns, segments, timetables };
}
