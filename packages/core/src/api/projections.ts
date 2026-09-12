import type {
  FareMatrixEncoded,
  LineEncoded,
  NetworkEncoded,
  PatternEncoded,
  SegmentEncoded,
  StationEncoded,
  StopEncoded,
  TimetableEncoded,
  TransferEncoded,
} from "../schema/index.js";

/**
 * API response projections.
 *
 * The canonical files under `data/` remain the single source of truth and keep
 * provenance (`source`, `source_ids`, `extras`) for tracing. The HTTP API is a
 * consumer-facing projection: it drops that provenance and derived/duplicate
 * fields, and exposes exactly what is needed to query stations and build a
 * routing index. This keeps payloads small and the contract stable.
 */

export function projectNetwork(n: NetworkEncoded) {
  return {
    id: n.id,
    name: n.name,
    name_en: n.name_en,
    city: n.city,
    country_code: n.country_code,
    currency: n.currency,
    timezone: n.timezone,
    coordinate_system: n.coordinate_system,
    default_units: n.default_units,
    routing: n.routing,
  };
}

export function projectLine(l: LineEncoded) {
  return {
    id: l.id,
    name: l.name,
    names: l.names,
    color: l.color,
    text_color: l.text_color,
    mode: l.mode,
    status: l.status,
    loop: l.loop,
  };
}

export function projectStation(s: StationEncoded, lines: string[], isInterchange: boolean) {
  return {
    id: s.id,
    name: s.name,
    names: s.names,
    location: s.location,
    schematic: s.schematic,
    status: s.status,
    lines,
    is_interchange: isInterchange,
  };
}

export function projectStop(s: StopEncoded) {
  return {
    id: s.id,
    station_id: s.station_id,
    line_id: s.line_id,
    sequence: s.sequence,
    is_terminal: s.is_terminal,
    location: s.location,
    schematic: s.schematic,
  };
}

export function projectPattern(p: PatternEncoded) {
  return {
    id: p.id,
    line_id: p.line_id,
    name: p.name,
    names: p.names,
    stop_ids: p.stop_ids,
    origin_stop_id: p.origin_stop_id,
    terminal_stop_id: p.terminal_stop_id,
    is_primary: p.is_primary,
    junction_stop_id: p.junction_stop_id,
    color: p.color,
  };
}

export function projectSegment(s: SegmentEncoded) {
  return {
    id: s.id,
    line_id: s.line_id,
    from_stop_id: s.from_stop_id,
    to_stop_id: s.to_stop_id,
    from_station_id: s.from_station_id,
    to_station_id: s.to_station_id,
    direction: s.direction,
    travel_time_seconds: s.travel_time_seconds,
    travel_time_source: s.travel_time_source,
    distance_km: s.distance_km,
  };
}

export function projectTransfer(t: TransferEncoded) {
  return {
    id: t.id,
    station_id: t.station_id,
    from_line_id: t.from_line_id,
    to_line_id: t.to_line_id,
    from_stop_id: t.from_stop_id,
    to_stop_id: t.to_stop_id,
    walk_time_seconds: t.walk_time_seconds,
    walk_distance_meters: t.walk_distance_meters,
    is_out_of_station: t.is_out_of_station,
  };
}

export function projectTimetable(t: TimetableEncoded) {
  return {
    id: t.id,
    station_id: t.station_id,
    stop_id: t.stop_id,
    line_id: t.line_id,
    destination_stop_id: t.destination_stop_id,
    origin_stop_id: t.origin_stop_id,
    pattern_id: t.pattern_id,
    direction_type: t.direction_type,
    direction_label: t.direction_label,
    first_train: t.first_train,
    last_train: t.last_train,
    is_arrival: t.is_arrival,
    service: t.service,
  };
}

export function projectFareMatrix(f: FareMatrixEncoded) {
  return {
    currency: f.currency,
    unit: f.unit,
    station_ids: f.station_ids,
    fares: f.fares,
  };
}
