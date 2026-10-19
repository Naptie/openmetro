import {
  buildFeedTopology,
  buildRailSchedule,
  enrichFeedStations,
  type FeedStation,
  htmlText,
  type OsmFeed,
  parseHHMM,
  type RailTrip
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import type { ThsrSources } from './fetch.js';

export const NETWORK_ID = 'cn-taiwan-hsr';
export function parseThsrStations(html: string, osm: OsmFeed): (FeedStation & { query: string })[] {
  const picker = /<select\b[^>]*id="select_location01"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
  if (!picker) throw new Error('THSR station selector missing');
  const stations = [
    ...picker.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g)
  ].map((match, index) => ({
    code: String(index + 1).padStart(2, '0'),
    key: String(index + 1).padStart(2, '0'),
    zh: htmlText(match[2]!),
    en: '',
    query: match[1]!
  }));
  const own = {
    ...osm,
    elements: osm.elements.filter((element) =>
      /高鐵|High Speed Rail/i.test(
        `${element.tags?.network ?? ''} ${element.tags?.['network:en'] ?? ''}`
      )
    )
  };
  const enriched = enrichFeedStations(stations, own);
  return enriched.map((station, index) => ({ ...station, query: stations[index]!.query }));
}

export function parseThsrQuote(
  raw: unknown,
  query?: { from: string; to: string; date: string }
): {
  trips: RailTrip[];
  fare: number;
  stationNames: Map<string, string>;
} {
  const value = raw as {
    success: boolean;
    data?: {
      DepartureTable: {
        Title: { StartStationName: string; EndStationName: string; TitleSplit1: string };
        TrainItem: {
          TrainNumber: string;
          StationInfo: {
            StationNo: string;
            StationName: string;
            DepartureTime: string;
            Show: boolean;
          }[];
        }[];
      };
      PriceTable: { Coach: string[] };
    };
  };
  if (!value.success || !value.data || !Array.isArray(value.data.DepartureTable?.TrainItem))
    throw new Error('THSR query failed');
  if (query) {
    const title = value.data.DepartureTable.Title;
    const fold = (name: string | undefined) => name?.replaceAll('臺', '台').trim();
    if (
      fold(title?.StartStationName) !== fold(query.from) ||
      fold(title?.EndStationName) !== fold(query.to)
    )
      throw new Error(`THSR returned another station pair for ${query.from}->${query.to}`);
    if (!title?.TitleSplit1?.startsWith(query.date.replaceAll('-', '/')))
      throw new Error('THSR returned the wrong timetable date');
  }
  const price = value.data.PriceTable?.Coach?.[0];
  if (!price || !/^\$[\d,]+$/.test(price)) throw new Error('THSR standard adult fare missing');
  const fare = Number(price.replace(/[$,]/g, ''));
  if (!Number.isFinite(fare) || fare <= 0) throw new Error('Invalid THSR adult fare');
  const stationNames = new Map<string, string>();
  const trips = value.data.DepartureTable.TrainItem.map((train) => {
    const calls = train.StationInfo.filter((station) => {
      if (!station.DepartureTime && !station.Show) return false;
      if (!/^\d{2}:\d{2}$/.test(station.DepartureTime) || parseHHMM(station.DepartureTime) == null)
        throw new Error(`Invalid THSR call ${train.TrainNumber}/${station.StationNo}`);
      if (!station.StationName) throw new Error(`Missing THSR station name ${station.StationNo}`);
      const name = station.StationName.replaceAll('臺', '台').trim();
      if (stationNames.has(station.StationNo) && stationNames.get(station.StationNo) !== name)
        throw new Error(`Conflicting THSR station identity ${station.StationNo}`);
      stationNames.set(station.StationNo, name);
      return true;
    }).sort((a, b) => Number(a.StationNo) - Number(b.StationNo));
    if (calls.length < 2 || new Set(calls.map((call) => call.StationNo)).size !== calls.length)
      throw new Error(`Invalid THSR calls ${train.TrainNumber}`);
    const delta =
      (parseHHMM(calls.at(-1)!.DepartureTime)! - parseHHMM(calls[0]!.DepartureTime)! + 1440) % 1440;
    if (delta > 720) calls.reverse();
    return {
      id: train.TrainNumber,
      calls: calls.map((call, i) =>
        i === calls.length - 1
          ? { station: call.StationNo, arrival: call.DepartureTime }
          : { station: call.StationNo, departure: call.DepartureTime }
      )
    };
  });
  return { fare, trips, stationNames };
}

export function normalizeThsr(raw: ThsrSources) {
  const stations = parseThsrStations(raw.stationPage, raw.osm);
  if (stations.length < 2) throw new Error('THSR station selector is empty');
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: 'thsrc',
    lines: [
      { code: 'HSR', zh: '台灣高鐵', en: 'Taiwan High Speed Rail', color: '#ec6c00', mode: 'other' }
    ],
    stations,
    alignments: [{ id: 'HSR', line: 'HSR', codes: stations.map((station) => station.code) }]
  });
  topology.lines = topology.lines.map((line) => ({
    ...line,
    extras: { rail_service: 'high_speed' }
  }));
  const trips = new Map<string, RailTrip>();
  const stationNames = new Map(
    stations.map((station) => [station.code, station.zh.replaceAll('臺', '台').trim()])
  );
  const fares: { from: string; to: string; price: number }[] = [];
  for (const query of raw.quotes) {
    const result = parseThsrQuote(query.data, {
      from: stationNames.get(query.from)!,
      to: stationNames.get(query.to)!,
      date: raw.date
    });
    for (const [code, name] of result.stationNames) {
      if (stationNames.get(code) !== name)
        throw new Error(`THSR station selector/query identity mismatch: ${code}/${name}`);
    }
    for (const trip of result.trips) {
      const old = trips.get(trip.id);
      if (old && JSON.stringify(old.calls) !== JSON.stringify(trip.calls))
        throw new Error(`THSR inconsistent calls ${trip.id}`);
      trips.set(trip.id, trip);
    }
    const from = topology.stationByCode.get(query.from),
      to = topology.stationByCode.get(query.to);
    if (!from || !to) throw new Error('Unknown THSR fare station');
    fares.push({ from: from.id, to: to.id, price: result.fare });
  }
  const schedule = buildRailSchedule(topology, [...trips.values()], {
    source: 'thsrc',
    date: raw.date,
    service: '高鐵定期旅客列車'
  });
  topology.segments = schedule.segments;
  if (topology.segments.some((segment) => segment.travel_time_source !== 'source'))
    throw new Error('THSR adjacent train timings incomplete');
  const notes = `台灣高鐵 ${raw.date} 的官方班表，包含區間車與各站停靠資訊。票價為標準車廂成人對號座單程全票，不含優惠、商務車廂與自由座。行程耗時為靜態估算，不含候車、班次銜接與訂位；請依實際班次確認停靠站。`;
  return {
    topology,
    network: feedNetwork(NETWORK_ID, 'CN-71', '台灣高鐵', 'Taiwan High Speed Rail', notes),
    timetables: schedule.timetables,
    fares: feedFares(NETWORK_ID, topology, raw.sources, fares),
    sources: raw.sources
  };
}
