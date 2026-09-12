interface Line {
  id: string;
  name: string;
  names?: { zh?: string; en?: string };
  color?: string;
  text_color?: string;
  mode?: string;
  status?: string;
  loop?: boolean;
}

interface Station {
  id: string;
  name: string;
  names?: { zh?: string; en?: string };
  location?: { lon: number; lat: number; crs: string };
  schematic?: unknown;
  status?: string;
  lines?: string[];
  is_interchange?: boolean;
}

interface Stop {
  id: string;
  station_id: string;
  line_id: string;
  sequence: number;
  is_terminal?: boolean;
  location?: unknown;
  schematic?: unknown;
}

interface Pattern {
  id: string;
  line_id: string;
  name?: string;
  names?: { zh?: string; en?: string };
  stop_ids: readonly string[];
  origin_stop_id: string;
  terminal_stop_id: string;
  is_primary: boolean;
  junction_stop_id?: string;
  color?: string;
}

interface Timetable {
  id: string;
  station_id: string;
  stop_id: string;
  line_id: string;
  destination_stop_id?: string;
  origin_stop_id?: string;
  pattern_id?: string;
  direction_type?: string;
  direction_label?: string;
  first_train: readonly string[];
  last_train: readonly string[];
  is_arrival?: boolean;
  service?: unknown;
}

interface StationStatus {
  timetable_id: string;
  line_id: string;
  destination_stop_id?: string;
  is_in_service: boolean;
  first_train: string;
  last_train: string;
  timezone: string;
  now: string;
}

interface StationDetail {
  id: string;
  name: string;
  names?: { zh?: string; en?: string };
  location?: { lon: number; lat: number; crs: string };
  schematic?: unknown;
  lines?: string[];
  is_interchange?: boolean;
  transfers: unknown[];
  timetables: Timetable[];
  status: StationStatus[];
}

interface RoutePlan {
  from_station_id: string;
  to_station_id: string;
  total_seconds: number;
  transfers: number;
  legs: {
    kind: "ride" | "transfer";
    line_id?: string;
    from_station_id: string;
    to_station_id: string;
    seconds: number;
    station_ids?: string[];
  }[];
}

export type { Line, Pattern, RoutePlan, Station, StationDetail, StationStatus, Stop, Timetable };
