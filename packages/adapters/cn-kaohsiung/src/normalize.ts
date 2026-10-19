import {
  deriveCumulativeTimes,
  deriveTransfers,
  entitySchemaUrl,
  type FareMatrixEncoded,
  fillStraightLineDistances,
  haversineKm,
  type LineEncoded,
  type NetworkEncoded,
  normalizeTimetableTimes,
  type PatternEncoded,
  placeholderCity,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import type { KaohsiungSources } from './fetch.js';

/** Reindex prior official quotes after a topology-only sync. Fresh quotes win. */
export function retainFares(
  current: FareMatrixEncoded,
  previous: FareMatrixEncoded
): FareMatrixEncoded {
  if (current.network_id !== previous.network_id) throw new Error('Fare network mismatch');
  const index = new Map(previous.station_ids.map((id, i) => [id, i]));
  const fares = current.station_ids.map((from, i) =>
    current.station_ids.map((to, j) => {
      const fresh = current.fares[i]![j];
      if (fresh != null) return fresh;
      const a = index.get(from);
      const b = index.get(to);
      return a != null && b != null ? (previous.fares[a]?.[b] ?? null) : null;
    })
  );
  return { ...current, fares, source: [...previous.source, ...current.source] };
}

export function normalizeKaohsiung(input: KaohsiungSources) {
  const networkId = 'cn-kaohsiung';
  const stationId = (code: string) => `${networkId}-${code.toLowerCase()}`;
  const lineId = (code: string) => `${networkId}-line-${code.toLowerCase()}`;
  const stopId = (code: string) => `${networkId}-stop-${code.toLowerCase()}`;
  const byCode = new Map(input.stations.flatMap((s) => s.codes.map((c) => [c, s] as const)));
  const stations: StationEncoded[] = input.stations.map((s) => ({
    id: stationId(s.key),
    name: s.zh,
    names: { zh: s.zh, en: s.en },
    status: 'operating',
    location: s.location,
    source_ids: [
      { source: 'krtc-stations', id: s.url },
      { source: 'photon-osm', id: s.osmId }
    ],
    extras: {
      station_codes: s.codes,
      names_source: 'official',
      location_source: 'photon',
      coordinate_note:
        'Rail POI matched automatically; operator map centres are not station coordinates.'
    }
  }));
  const definitions: Record<string, { zh: string; en: string; color: string }> = {
    R: { zh: '紅線', en: 'Red Line', color: '#E20B65' },
    O: { zh: '橘線', en: 'Orange Line', color: '#FAA73F' },
    C: { zh: '環狀輕軌', en: 'Circular Light Rail', color: '#66AA33' }
  };
  const lines: LineEncoded[] = input.lines.map((l) => ({
    id: lineId(l.code),
    name: definitions[l.code]!.zh,
    names: { zh: definitions[l.code]!.zh, en: definitions[l.code]!.en },
    aliases: [],
    short_name: l.code,
    color: definitions[l.code]!.color,
    mode: l.code === 'C' ? 'light_rail' : 'metro',
    status: 'operating',
    loop: l.code === 'C',
    source_ids: [{ source: 'krtc-stations', id: l.code }]
  }));
  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  for (const line of input.lines) {
    for (const [i, code] of line.stops.entries()) {
      const s = byCode.get(code);
      if (!s) throw new Error(`Missing KRTC station ${code}`);
      stops.push({
        id: stopId(code),
        station_id: stationId(s.key),
        line_id: lineId(line.code),
        sequence: i,
        is_terminal: line.code !== 'C' && (i === 0 || i === line.stops.length - 1),
        location: s.location,
        source_id: 'krtc-stations',
        extras: { station_code: code }
      });
    }
    patterns.push({
      id: `${lineId(line.code)}-main`,
      line_id: lineId(line.code),
      stop_ids: line.stops.map(stopId),
      origin_stop_id: stopId(line.stops[0]!),
      terminal_stop_id: stopId(line.stops.at(-1)!),
      is_primary: true,
      source_ids: [{ source: 'krtc-stations', id: line.code }]
    });
  }
  const segments: SegmentEncoded[] = [];
  const addEdge = (
    a: string,
    b: string,
    seconds: number,
    both: boolean,
    source: 'source' | 'planner'
  ) => {
    if (!(seconds > 0)) throw new Error(`No KRTC runtime ${a}/${b}`);
    segments.push({
      id: `${stopId(a)}-to-${b.toLowerCase()}`,
      line_id: lineId(a[0]!),
      from_stop_id: stopId(a),
      to_stop_id: stopId(b),
      from_station_id: stationId(byCode.get(a)!.key),
      to_station_id: stationId(byCode.get(b)!.key),
      direction: both ? 'both' : 'forward',
      travel_time_seconds: seconds,
      travel_time_source: source,
      source_id: source === 'source' ? 'krtc-lrt-travel-matrix' : 'krtc-planner',
      ...(source === 'planner'
        ? {
            extras: {
              planner_time_source: 'krtc-cumulative-difference'
            }
          }
        : {})
    });
  };
  for (const line of input.lines.filter((l) => l.code !== 'C')) {
    // Planner queries may name the shared station R10 or O5. Resolve its
    // occurrence on this line without changing the physical fare identity.
    const onLine = (code: string) => byCode.get(code)?.codes.find((c) => line.stops.includes(c));
    const journeys = input.quotes.flatMap((q) => {
      const from = onLine(q.from);
      const to = onLine(q.to);
      return from && to && from !== to ? [{ from, to, seconds: q.seconds }] : [];
    });
    for (const edge of deriveCumulativeTimes(line.stops, journeys))
      addEdge(edge.from, edge.to, edge.seconds, false, 'planner');
  }
  for (const edge of input.lrtEdges) addEdge(edge.from, edge.to, edge.seconds, false, 'source');
  const timetables: TimetableEncoded[] = [];
  const calendar = input.serviceCalendar;
  const holidays = new Set(calendar?.holiday_dates);
  const shiftDate = (date: string, days: number) =>
    new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
  const isHoliday = (date: string) => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday === 0 || weekday === 6 || holidays.has(date);
  };
  const exceptionalDates = [...new Set([...holidays].flatMap((d) => [d, shiftDate(d, -1)]))]
    .filter((d) => calendar && d >= calendar.valid_from && d <= calendar.valid_to)
    .sort();
  for (const item of input.timetables) {
    const s = byCode.get(item.code);
    if (!s) throw new Error(`Unknown timetable station ${item.code}`);
    const line = input.lines.find((l) => l.stops.includes(item.code))!;
    for (const row of item.rows) {
      const destination =
        row.direction === 'linear'
          ? line.stops.find((c) => byCode.get(c)!.zh === row.destination)
          : undefined;
      if (row.direction === 'linear' && !destination)
        throw new Error(`Unknown destination ${row.destination}`);
      const dayRows =
        row.days ??
        (line.code === 'C'
          ? ([
              ['平日', 0],
              ['假日', 5]
            ] as const)
          : ([
              ['平日', 0],
              ['假日前一日', 4],
              ['週六', 5],
              ['週日', 6]
            ] as const)
        ).map(([label, day]) => ({
          label,
          first: row.first[day] ?? row.first[0]!,
          last: row.last[day] ?? row.last[0]!
        }));
      const overrides = Object.fromEntries(
        exceptionalDates.map((date) => {
          const holiday = isHoliday(date);
          const nextHoliday = isHoliday(shiftDate(date, 1));
          const label =
            line.code === 'C'
              ? holiday
                ? '假日'
                : '平日'
              : holiday
                ? nextHoliday
                  ? '週六'
                  : '週日'
                : nextHoliday
                  ? '假日前一日'
                  : '平日';
          const day = dayRows.find((d) => d.label === label);
          if (!day) throw new Error(`Missing KRTC day type ${label}`);
          const window = normalizeTimetableTimes({
            first_train: [day.first],
            last_train: [day.last]
          });
          return [date, { first_train: window.first_train[0], last_train: window.last_train[0] }];
        })
      );
      timetables.push(
        normalizeTimetableTimes({
          id: `${stopId(item.code)}-tt-${destination ?? row.direction}`,
          station_id: stationId(s.key),
          stop_id: stopId(item.code),
          line_id: lineId(line.code),
          pattern_id: `${lineId(line.code)}-main`,
          station_code: item.code,
          destination_stop_id: destination ? stopId(destination) : undefined,
          direction_type: row.direction,
          direction_label:
            row.direction === 'loop_outer'
              ? '順行'
              : row.direction === 'loop_inner'
                ? '逆行'
                : row.destination,
          first_train: row.first,
          last_train: row.last,
          valid_from: calendar?.valid_from,
          valid_to: calendar?.valid_to,
          source_id: 'krtc-timetables',
          extras: {
            ...(calendar ? { date_overrides: overrides } : {}),
            calendar_note:
              'Published weekday, holiday and pre-holiday rows use the Taiwan public-holiday calendar; special operating announcements remain subject to the operator.'
          }
        })
      );
    }
  }
  const transfers: TransferEncoded[] = deriveTransfers(stations, stops, [], {
    crossStation: false
  }).map((t) => ({ ...t, walk_time_seconds: 120, source_id: 'krtc-routing-default' }));
  // Inter-system interchanges have different station identities.
  // Derive nearby metro/light-rail walks from coordinates, without maintaining
  // a city-specific list. Distances and walk times are estimates, not official.
  for (const a of stops.filter((s) => s.line_id === lineId('C')))
    for (const b of stops.filter((s) => s.line_id !== lineId('C'))) {
      const distance = haversineKm(a.location!, b.location!) * 1000;
      if (distance > 400) continue;
      const seconds = Math.max(120, Math.round(distance / 1.3 + 90));
      for (const [from, to] of [
        [a, b],
        [b, a]
      ])
        transfers.push({
          id: `${from!.id}-walk-${to!.id}`,
          station_id: from!.station_id,
          from_stop_id: from!.id,
          to_stop_id: to!.id,
          from_line_id: from!.line_id,
          to_line_id: to!.line_id,
          walk_time_seconds: seconds,
          walk_distance_meters: Math.round(distance),
          is_out_of_station: true,
          source_id: 'auto-xfer/v1-krtc-proximity',
          extras: { distance_m: Math.round(distance), rule: 'metro-light-rail-within-400m' }
        });
    }
  const stationIds = stations.map((s) => s.id).sort();
  const matrix: (number | null)[][] = stationIds.map((a) =>
    stationIds.map((b) => (a === b ? 0 : null))
  );
  for (const q of input.quotes) {
    const a = stationIds.indexOf(stationId(byCode.get(q.from)!.key));
    const b = stationIds.indexOf(stationId(byCode.get(q.to)!.key));
    if (a === b) continue;
    if (matrix[a]![b] != null && matrix[a]![b] !== q.fare)
      throw new Error(`Conflicting KRTC fares ${q.from}/${q.to}`);
    matrix[a]![b] = q.fare;
    matrix[b]![a] = q.fare;
  }
  const fares = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: networkId,
    generated_at: new Date().toISOString(),
    source: [] as FareMatrixEncoded['source'],
    currency: 'TWD',
    unit: 'TWD',
    station_ids: stationIds,
    fares: matrix
  } satisfies FareMatrixEncoded;
  const network: NetworkEncoded = {
    id: networkId,
    name: '高雄捷運',
    names: { zh: '高雄捷運', en: 'Kaohsiung Metro' },
    city: placeholderCity('CN-7106'),
    country_code: 'CN',
    currency: 'TWD',
    timezone: 'Asia/Taipei',
    service_calendar: calendar,
    coordinate_system: 'wgs84',
    default_units: { distance: 'km', time: 's', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '涵蓋高雄捷運與輕軌，提供官方首末班車、行車時間與單程票價。國定假日及假日前夕依適用日期的班表顯示。捷運與輕軌分別計價，跨系統聯程票價未提供。站點位置依 OpenStreetMap 資料，距離及跨系統步行時間為估算。'
  };
  return {
    network,
    lines,
    stations,
    stops,
    patterns,
    segments: fillStraightLineDistances(segments, stations),
    transfers,
    timetables,
    fares
  };
}
