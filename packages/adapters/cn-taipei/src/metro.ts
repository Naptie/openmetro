import {
  estimateTransferWalkSeconds,
  haversineKm,
  type prepareFeedNetwork,
  type StationEncoded,
  type TransferEncoded
} from '@openmetro/core';
import { feedFares } from '@openmetro/taiwan-shared';
import { METRO_INTERCHANGES } from './interchanges.js';

type PreparedNetwork = ReturnType<typeof prepareFeedNetwork>;
export interface MetroOperator {
  data: PreparedNetwork;
  sources: PreparedNetwork['fares']['source'];
}

/** Combine the metropolitan metro sources before publishing a normal network. */
export function mergeTaipeiMetro(operators: MetroOperator[]) {
  const primary = operators.find(({ data }) => data.network.id === 'cn-taipei')?.data;
  if (!primary || operators.length !== 3) throw new Error('Three Taipei metro sources required');
  const originalStations = new Map(
    operators.flatMap(({ data }) => data.stations.map((station) => [station.id, station] as const))
  );
  const aliases = new Map<string, string>();
  for (const link of METRO_INTERCHANGES) {
    if (!originalStations.has(link.from) || !originalStations.has(link.to))
      throw new Error(`Missing official metro interchange: ${link.from} / ${link.to}`);
    // Paid-area interchange platforms belong to the same physical station.
    // Separate concourses (including Airport MRT) retain distinct identities.
    if (!link.outOfStation) aliases.set(link.to, link.from);
  }
  const stationId = (id: string) => aliases.get(id) ?? id;
  const mergedStations = new Map<string, StationEncoded>();
  for (const station of originalStations.values()) {
    const id = stationId(station.id),
      previous = mergedStations.get(id);
    const refs = [...(previous?.source_ids ?? []), ...station.source_ids];
    mergedStations.set(id, {
      ...(previous ?? originalStations.get(id) ?? station),
      id,
      source_ids: [...new Map(refs.map((ref) => [`${ref.source}/${ref.id}`, ref])).values()]
    });
  }
  const stations = [...mergedStations.values()];
  const originalStops = operators.flatMap(({ data }) => data.stops);
  const stops = originalStops.map((stop) => ({ ...stop, station_id: stationId(stop.station_id) }));
  const lines = operators.flatMap(({ data }) => data.lines);
  const patterns = operators.flatMap(({ data }) => data.patterns);
  const segments = operators.flatMap(({ data }) =>
    data.segments.map((segment) => ({
      ...segment,
      from_station_id: stationId(segment.from_station_id),
      to_station_id: stationId(segment.to_station_id)
    }))
  );
  const timetables = operators.flatMap(({ data }) =>
    data.timetables.map((row) => ({
      ...row,
      station_id: stationId(row.station_id)
    }))
  );
  const transfers: TransferEncoded[] = operators.flatMap(({ data }) =>
    data.transfers.map((row) => ({
      ...row,
      station_id: stationId(row.station_id)
    }))
  );
  for (const link of METRO_INTERCHANGES) {
    const from = originalStations.get(link.from)!,
      to = originalStations.get(link.to)!;
    if (!from.location || !to.location) throw new Error('Metro interchange coordinates missing');
    const distance = Math.round(haversineKm(from.location, to.location) * 1000);
    if (distance > 1500) throw new Error(`Metro interchange coordinates disagree: ${link.from}`);
    const officialSeconds = 'seconds' in link ? link.seconds : undefined;
    const seconds =
      officialSeconds ??
      estimateTransferWalkSeconds(
        distance,
        primary.network.routing.default_transfer_seconds,
        primary.network.routing.max_transfer_seconds ?? Infinity
      );
    for (const [a, b] of [
      [link.from, link.to],
      [link.to, link.from]
    ]) {
      for (const start of originalStops.filter((stop) => stop.station_id === a)) {
        for (const end of originalStops.filter((stop) => stop.station_id === b)) {
          transfers.push({
            id: `xfer-${start.id}-${end.id}`,
            station_id: stationId(start.station_id),
            from_line_id: start.line_id,
            to_line_id: end.line_id,
            from_stop_id: start.id,
            to_stop_id: end.id,
            walk_time_seconds: seconds,
            walk_distance_meters: distance,
            is_out_of_station: link.outOfStation,
            source_id: officialSeconds ? 'interchange/taipei-metro' : 'estimated-walk/taipei-metro',
            extras: {
              connection_source: link.source,
              walk_time_source: officialSeconds ? 'official' : 'estimated'
            }
          });
        }
      }
    }
  }
  const sources = operators.flatMap((operator) => operator.sources);
  const prices = operators.flatMap(({ data }) =>
    data.fares.station_ids.flatMap((from, i) =>
      data.fares.station_ids.flatMap((to, j) => {
        const price = data.fares.fares[i]?.[j];
        return i < j && price != null && price > 0
          ? [{ from: stationId(from), to: stationId(to), price }]
          : [];
      })
    )
  );
  const scope =
    '涵蓋台北、新北與桃園捷運，依官方資料整合同站及站外轉乘；高鐵、台鐵、阿里山及其他城市各自成網。耗時為靜態估算，不含候車與班次銜接；跨票制聯程票價未提供，僅保留官方已知票價。';
  return {
    data: {
      network: {
        ...primary.network,
        service_calendar: operators.find(({ data }) => data.network.service_calendar)?.data.network
          .service_calendar,
        name: '臺北都會區捷運',
        names: { zh: '臺北都會區捷運', en: 'Taipei Metropolitan MRT' },
        notes: scope,
        service_scope: scope
      },
      lines,
      stations,
      stops,
      patterns,
      segments,
      transfers,
      timetables,
      fares: feedFares('cn-taipei', { stations }, sources, prices)
    },
    sources
  };
}
