import type { StationEncoded, StopEncoded, TimetableEncoded } from "../schema/index.js";
import { isForcedOutOfService } from "../station-overrides.js";

/**
 * Demote stations that sit on a line which publishes first/last trains but
 * have zero timetable records of their own — plus any station listed in
 * `OUT_OF_SERVICE_STATIONS` (official feed still shows it; service postponed).
 *
 * Rationale: official sources often omit stations that are not in passenger
 * service (renovating, not yet open) while still listing them on the map.
 * We cannot distinguish planned / under_construction / closed from the
 * timetable feed alone, so they become a single `out_of_service` status.
 *
 * Lines with **zero** published timetables (e.g. trams the operator does not
 * feed) leave every station as `operating` unless forced by the override list.
 */
export function applyTimetableServiceStatus<
  T extends {
    id: string;
    status: StationEncoded["status"];
    name?: string;
    names?: { zh?: string };
  },
>(stations: T[], stops: StopEncoded[], timetables: TimetableEncoded[]): T[] {
  const ttStations = new Set(timetables.map((t) => t.station_id));
  const ttLines = new Set(timetables.map((t) => t.line_id));
  const stationHasPublishingLine = new Set<string>();
  for (const stop of stops) {
    if (ttLines.has(stop.line_id)) stationHasPublishingLine.add(stop.station_id);
  }
  return stations.map((station) => {
    const zh = station.names?.zh ?? station.name ?? "";
    if (isForcedOutOfService(zh)) {
      return { ...station, status: "out_of_service" as const };
    }
    if (station.status !== "operating") return station;
    if (ttStations.has(station.id)) return station;
    if (!stationHasPublishingLine.has(station.id)) return station;
    return { ...station, status: "out_of_service" as const };
  });
}
