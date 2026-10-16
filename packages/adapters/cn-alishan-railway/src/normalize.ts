import {
  asciiSlug,
  buildFeedTopology,
  buildRailSchedule,
  type FeedStation,
  htmlText,
  type OsmFeed,
  parseHHMM,
  type RailTrip,
  type TimetableEncoded
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import type { AlishanSources } from './fetch.js';

export const NETWORK_ID = 'cn-alishan-railway';
export function parseAlishanTables(html: string): string[][][] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].map((table) =>
    [...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => htmlText(cell[1]!))
    )
  );
}
function times(value: string): string[] {
  const found = value.match(/\d{2}:\d{2}/g) ?? [];
  if (!found.length || found.some((time) => parseHHMM(time) == null))
    throw new Error(`Invalid forest railway time ${value}`);
  return found;
}
export function parseAlishanMain(html: string): { stations: string[]; trips: RailTrip[] } {
  const timetable = parseAlishanTables(html).filter((table) => table[0]?.[0] === '車種/車次');
  if (timetable.length !== 2) throw new Error('Forest main-line timetable tables missing');
  const stations = timetable[0]!.slice(1).map((row) => row[0]!);
  const trips: RailTrip[] = [];
  for (const table of timetable) {
    const headers = table[0]!;
    for (let column = 1; column < headers.length; column++) {
      const header = headers[column]!;
      const id = /(\d+)車次/.exec(header)?.[1];
      if (!id || !header.includes('每日行駛'))
        throw new Error('Forest main-line service calendar changed');
      const calls = table.slice(1).flatMap((row) => {
        const value = row[column];
        if (value == null) throw new Error('Forest main-line timetable column missing');
        if (!value || value === '-') return [];
        const parsed = times(value);
        return [
          {
            station: row[0]!,
            ...(parsed.length > 1 ? { arrival: parsed[0] } : {}),
            departure: parsed.at(-1)!
          }
        ];
      });
      if (calls.length < 2) throw new Error(`Forest railway train ${id} missing calls`);
      const last = calls.at(-1)!;
      const terminal = { station: last.station, arrival: last.departure };
      trips.push({ id, calls: [...calls.slice(0, -1), terminal] });
    }
  }
  if (stations.length < 10 || new Set(stations).size !== stations.length)
    throw new Error('Forest main-line station order incomplete');
  return { stations, trips };
}

export function parseAlishanBranches(html: string): RailTrip[] {
  const timetable = parseAlishanTables(html).filter((table) => table[0]?.[0] === '車次');
  if (timetable.length !== 4) throw new Error('Forest branch timetable tables missing');
  return timetable.flatMap((table) => {
    const from = /^(.+?)\(開\)$/.exec(table[0]![1]!)?.[1];
    const to = /^(.+?)\(到\)$/.exec(table[0]![2]!)?.[1];
    if (
      !from ||
      !to ||
      ![from, to].includes('阿里山') ||
      ![from, to].some((name) => ['神木', '沼平'].includes(name))
    )
      throw new Error('Forest branch timetable identity changed');
    return table.slice(1).map((row) => {
      if (!/^\d+$/.test(row[0] ?? '') || row.length !== 3)
        throw new Error('Forest branch train format changed');
      return {
        id: row[0]!,
        calls: [
          { station: from, departure: times(row[1]!)[0]! },
          { station: to, arrival: times(row[2]!)[0]! }
        ]
      };
    });
  });
}

export function parseSunrise(
  html: string,
  date: string
): { departure: string; last_return: string } | undefined {
  const match =
    /(\d{1,2})月(\d{1,2})日祝山線觀日列車\s*(\d{2}:\d{2})(?:發|開)車[，,、\s]*回程末班車(?:為|時間為)\s*(\d{2}:\d{2})/.exec(
      htmlText(html)
    );
  if (
    !match ||
    Number(match[1]) !== Number(date.slice(5, 7)) ||
    Number(match[2]) !== Number(date.slice(8, 10))
  )
    return undefined;
  return { departure: times(match[3]!)[0]!, last_return: times(match[4]!)[0]! };
}

function forestStation(name: string, osm: OsmFeed): FeedStation {
  const matches = osm.elements.filter(
    (element) => element.tags?.name === name || element.tags?.name?.includes(`(${name})`)
  );
  const owned = matches.filter((element) =>
    /阿里山|Alishan/.test(
      `${element.tags?.network ?? ''} ${element.tags?.operator ?? ''} ${element.tags?.['operator:en'] ?? ''}`
    )
  );
  const candidates = owned.length
    ? owned
    : matches.filter(
        (element) =>
          element.lat > 23.45 && element.lat < 23.6 && element.lon > 120.75 && element.lon < 120.85
      );
  if (candidates.length !== 1 || !candidates[0]!.tags?.['name:en'])
    throw new Error(`Forest railway enrichment missing or ambiguous: ${name}`);
  const station = candidates[0]!,
    en = station.tags!['name:en']!;
  const code = asciiSlug(en);
  return {
    code,
    key: code,
    zh: name,
    en,
    location: { lat: station.lat, lon: station.lon, crs: 'wgs84' },
    enrichment_id: String(station.id),
    extras: { name_en_source: 'openstreetmap', location_source: 'overpass' }
  };
}

export function normalizeAlishan(raw: AlishanSources) {
  const main = parseAlishanMain(raw.main),
    branches = parseAlishanBranches(raw.branches);
  const lineSpecs = [
    {
      code: 'AL',
      zh: '阿里山本線',
      en: 'Alishan Main Line',
      color: '#be352c',
      names: main.stations
    },
    { code: 'SM', zh: '神木線', en: 'Shenmu Line', color: '#228b22', names: ['阿里山', '神木'] },
    { code: 'ZP', zh: '沼平線', en: 'Zhaoping Line', color: '#1676a5', names: ['阿里山', '沼平'] },
    {
      code: 'ZS',
      zh: '祝山線',
      en: 'Zhushan Line',
      color: '#ee9820',
      names: ['阿里山', '對高岳', '祝山']
    }
  ];
  const stationByName = new Map(
    [...new Set(lineSpecs.flatMap((line) => line.names))].map((name) => [
      name,
      forestStation(name, raw.osm)
    ])
  );
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: 'afrch',
    lines: lineSpecs.map((line) => ({ ...line, mode: 'other' })),
    stations: lineSpecs.flatMap((line) =>
      line.names.map((name) => {
        const station = stationByName.get(name)!;
        return { ...station, code: `${line.code}-${station.code}`, source_code: station.code };
      })
    ),
    alignments: lineSpecs.map((line) => ({
      id: line.code,
      line: line.code,
      codes: line.names.map((name) => `${line.code}-${stationByName.get(name)!.code}`)
    }))
  });
  const trips: RailTrip[] = [...main.trips, ...branches].map((trip) => ({
    ...trip,
    calls: trip.calls.map((call) => ({ ...call, station: stationByName.get(call.station)!.code }))
  }));
  // The physical main line includes stations skipped by through trains. Keep
  // that corridor for drawing, but route only over consecutive published calls.
  const corridor = {
    ...topology.patterns.find((pattern) => pattern.line_id.endsWith('-al'))!,
    extras: { geometry_only: true }
  };
  topology.patterns = topology.patterns.map((pattern) =>
    pattern.id === corridor.id ? corridor : pattern
  );
  const services = new Map<string, string>();
  const rideEdges = new Map<string, (typeof topology.segments)[number]>();
  topology.segments = topology.segments.filter((segment) => segment.line_id !== corridor.line_id);
  for (const trip of trips.slice(0, main.trips.length)) {
    const calls = trip.calls.map((call) => topology.stopByCode.get(`AL-${call.station}`)!);
    const ordered =
      corridor.stop_ids.indexOf(calls[0]!.id) < corridor.stop_ids.indexOf(calls.at(-1)!.id)
        ? calls
        : [...calls].reverse();
    const signature = ordered.map((stop) => stop.id).join('|');
    let id = services.get(signature);
    if (!id) {
      id = `${corridor.id}-service-${trip.id}`;
      services.set(signature, id);
      topology.patterns.push({
        ...corridor,
        id,
        stop_ids: ordered.map((stop) => stop.id),
        origin_stop_id: ordered[0]!.id,
        terminal_stop_id: ordered.at(-1)!.id,
        is_primary: false,
        geometry_reference_pattern_id: corridor.id,
        extras: undefined
      });
      for (let i = 1; i < ordered.length; i++) {
        const from = ordered[i - 1]!,
          to = ordered[i]!;
        const key = `${from.id}|${to.id}`;
        if (rideEdges.has(key)) continue;
        rideEdges.set(key, {
          id: `${corridor.line_id}-ride-${rideEdges.size + 1}`,
          line_id: corridor.line_id,
          from_stop_id: from.id,
          to_stop_id: to.id,
          from_station_id: from.station_id,
          to_station_id: to.station_id,
          direction: 'both',
          source_id: 'afrch'
        });
      }
    }
    trip.pattern_id = id;
  }
  topology.segments.push(...rideEdges.values());
  const schedule = buildRailSchedule(topology, trips, {
    source: 'afrch',
    service: '定期旅客列車'
  });
  topology.segments = schedule.segments;
  const timetables: TimetableEncoded[] = [...schedule.timetables];
  const announcement = parseSunrise(raw.home, raw.date);
  if (announcement) {
    const pattern = topology.patterns.find((pattern) => pattern.line_id.endsWith('-zs'))!;
    const stop = (name: string) => topology.stopByCode.get(`ZS-${stationByName.get(name)!.code}`)!;
    const rows = [
      { from: '阿里山', to: '祝山', first: announcement.departure, last: '' },
      { from: '祝山', to: '阿里山', first: '', last: announcement.last_return }
    ];
    for (const row of rows) {
      const from = stop(row.from),
        to = stop(row.to);
      timetables.push({
        id: `${from.id}-sunrise-${raw.date}`,
        station_id: from.station_id,
        stop_id: from.id,
        line_id: from.line_id,
        pattern_id: pattern.id,
        destination_stop_id: to.id,
        direction_type: 'linear',
        source_id: 'afrch',
        first_train: [row.first],
        last_train: [row.last],
        valid_from: raw.date,
        valid_to: raw.date,
        service: '當日觀日列車公告；其他班次時間未公布',
        extras: { timetable_scope: 'dated_announcement' }
      });
    }
  }
  const fareTables = parseAlishanTables(raw.fares),
    fareTable = fareTables.find((table) => table[0]?.[0] === '票價表');
  if (!fareTable) throw new Error('Forest standard reserved-seat fare matrix missing');
  const stationId = (name: string) =>
    topology.stations.find((station) => station.name === name)?.id;
  const prices: { from: string; to: string; price: number }[] = [];
  const header = fareTable[0]!;
  for (const row of fareTable.slice(1)) {
    const from = stationId(row[0]!);
    if (!from) continue;
    for (let i = 1; i < header.length; i++) {
      const to = stationId(header[i]!);
      if (!to || from === to) continue;
      if (!/^\d+$/.test(row[i] ?? '')) throw new Error('Forest main-line fare missing');
      prices.push({ from, to, price: Number(row[i]) });
    }
  }
  const branchFare = fareTables.find((table) => table[0]?.[0] === '支線別');
  const adult = branchFare?.find((row) => row[0]?.replace(/\s+/g, '') === '單程全票');
  if (!branchFare || !adult) throw new Error('Forest adult branch fares missing');
  for (const [line, destination] of [
    ['祝山線', '祝山'],
    ['神木線', '神木'],
    ['沼平線', '沼平']
  ]) {
    const i = branchFare[0]!.indexOf(line!);
    if (i < 1 || !/^\d+$/.test(adult[i] ?? '')) throw new Error('Forest branch fare missing');
    prices.push({
      from: stationId('阿里山')!,
      to: stationId(destination!)!,
      price: Number(adult[i])
    });
  }
  const mileage = parseAlishanTables(raw.mileage)[0];
  if (!mileage) throw new Error('Forest official mileage table missing');
  const nameById = new Map(topology.stations.map((station) => [station.id, station.name]));
  topology.segments = topology.segments.map((segment) => {
    const from = nameById.get(segment.from_station_id)!,
      to = nameById.get(segment.to_station_id)!;
    const row = mileage.find((row) => row[0] === from),
      column = mileage[0]!.indexOf(to);
    const value = column > 0 ? Number(row?.[column]) : NaN;
    return value > 0
      ? {
          ...segment,
          distance_km: value,
          extras: {
            ...segment.extras,
            distance_source: 'source',
            distance_method: 'official_mileage_matrix'
          }
        }
      : segment;
  });
  const notes =
    '涵蓋阿里山本線、神木線、沼平線及祝山線。本線與前兩條支線採官方定期班表；祝山線僅提供公告日期的觀日首班與回程末班，其他時間未公布。直達車依實際停靠站規劃，圖上沿完整線路走向顯示，途經不代表停靠。耗時包含班表已知的中途停站時間，仍為靜態估算，不保證候車或班次銜接。票價分本線與支線列示，未推算聯程票價；眠月線與水山步道不納入。';
  return {
    topology,
    network: feedNetwork(NETWORK_ID, 'CN-71', '阿里山森林鐵路', 'Alishan Forest Railway', notes),
    timetables,
    fares: feedFares(NETWORK_ID, topology, raw.sources, prices),
    sources: raw.sources
  };
}
