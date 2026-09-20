import type { StationEncoded, StopEncoded, TimetableEncoded } from '../schema/index.js';

/**
 * Demote stations that sit on a line which publishes first/last trains but
 * have zero timetable records of their own — plus any station listed in
 * `forcedOutOfService` (official feed still shows it; service postponed).
 *
 * Rationale: official sources often omit stations that are not in passenger
 * service (renovating, not yet open) while still listing them on the map.
 * The timetable feed alone cannot distinguish construction vs temporary
 * offline, so these become `out_of_service`. Adapters that know a stop is
 * not yet open should write `under_construction` directly instead.
 *
 * Lines with **zero** published timetables (e.g. trams the operator does not
 * feed) leave every station as `operating` unless forced by the override list.
 *
 * `forcedOutOfService` is adapter-supplied city data; the core stays
 * city-agnostic. Names are matched after trimming only, so adapters must
 * pre-fold rare CJK glyph variants before building their forced lists.
 */
export function applyTimetableServiceStatus<
  T extends {
    id: string;
    status: StationEncoded['status'];
    name?: string;
    names?: { zh?: string };
  }
>(
  stations: T[],
  stops: StopEncoded[],
  timetables: TimetableEncoded[],
  forcedOutOfService: readonly string[] = []
): T[] {
  const ttStations = new Set(timetables.map((t) => t.station_id));
  const ttLines = new Set(timetables.map((t) => t.line_id));
  const stationHasPublishingLine = new Set<string>();
  for (const stop of stops) {
    if (ttLines.has(stop.line_id)) stationHasPublishingLine.add(stop.station_id);
  }
  const forced = new Set(forcedOutOfService.map((n) => n.trim()));
  return stations.map((station) => {
    const zh = station.names?.zh ?? station.name ?? '';
    if (forced.has(zh.trim())) {
      return { ...station, status: 'out_of_service' as const };
    }
    if (station.status !== 'operating') return station;
    if (ttStations.has(station.id)) return station;
    if (!stationHasPublishingLine.has(station.id)) return station;
    return { ...station, status: 'out_of_service' as const };
  });
}
