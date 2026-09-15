import { z } from 'zod';

declare const apiCrsSchema: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
declare const apiNamesSchema: z.ZodObject<{
    zh: z.ZodString;
    en: z.ZodString;
}, "strip", z.ZodTypeAny, {
    zh: string;
    en: string;
}, {
    zh: string;
    en: string;
}>;
declare const apiGeoPointSchema: z.ZodObject<{
    lon: z.ZodNumber;
    lat: z.ZodNumber;
    crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
}, "strip", z.ZodTypeAny, {
    lon: number;
    lat: number;
    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
}, {
    lon: number;
    lat: number;
    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
}>;
declare const apiSchematicPointSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
}, "strip", z.ZodTypeAny, {
    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    x: number;
    y: number;
}, {
    crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    x: number;
    y: number;
}>;
declare const apiLineModeSchema: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
declare const apiLineStatusSchema: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
declare const apiLineSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    color: z.ZodOptional<z.ZodString>;
    text_color: z.ZodOptional<z.ZodString>;
    short_name: z.ZodString;
    mode: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
    status: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
    loop: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    short_name: string;
    mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
    loop: boolean;
    color?: string | undefined;
    text_color?: string | undefined;
}, {
    status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    short_name: string;
    mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
    loop: boolean;
    color?: string | undefined;
    text_color?: string | undefined;
}>;
declare const apiLineListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    color: z.ZodOptional<z.ZodString>;
    text_color: z.ZodOptional<z.ZodString>;
    short_name: z.ZodString;
    mode: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
    status: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
    loop: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    short_name: string;
    mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
    loop: boolean;
    color?: string | undefined;
    text_color?: string | undefined;
}, {
    status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    short_name: string;
    mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
    loop: boolean;
    color?: string | undefined;
    text_color?: string | undefined;
}>, "many">;
declare const apiStationStatusSchema: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
declare const apiStationSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    location: z.ZodOptional<z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>>;
    schematic: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>>;
    status: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
    lines: z.ZodArray<z.ZodString, "many">;
    is_interchange: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}, {
    status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}>;
declare const apiStationListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    location: z.ZodOptional<z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>>;
    schematic: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>>;
    status: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
    lines: z.ZodArray<z.ZodString, "many">;
    is_interchange: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}, {
    status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}>, "many">;
declare const apiDirectionTypeSchema: z.ZodEnum<["linear", "loop_inner", "loop_outer"]>;
declare const apiTimetableStatusSchema: z.ZodObject<{
    timetable_id: z.ZodString;
    station_id: z.ZodString;
    line_id: z.ZodString;
    destination_stop_id: z.ZodOptional<z.ZodString>;
    is_in_service: z.ZodBoolean;
    first_train: z.ZodString;
    last_train: z.ZodString;
    timezone: z.ZodString;
    now: z.ZodString;
}, "strip", z.ZodTypeAny, {
    timetable_id: string;
    station_id: string;
    line_id: string;
    is_in_service: boolean;
    first_train: string;
    last_train: string;
    timezone: string;
    now: string;
    destination_stop_id?: string | undefined;
}, {
    timetable_id: string;
    station_id: string;
    line_id: string;
    is_in_service: boolean;
    first_train: string;
    last_train: string;
    timezone: string;
    now: string;
    destination_stop_id?: string | undefined;
}>;
declare const apiStopSchema: z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    line_id: z.ZodString;
    sequence: z.ZodNumber;
    is_terminal: z.ZodOptional<z.ZodBoolean>;
    location: z.ZodOptional<z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>>;
    schematic: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
    is_terminal?: boolean | undefined;
}, {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
    is_terminal?: boolean | undefined;
}>;
declare const apiStopListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    line_id: z.ZodString;
    sequence: z.ZodNumber;
    is_terminal: z.ZodOptional<z.ZodBoolean>;
    location: z.ZodOptional<z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>>;
    schematic: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
    is_terminal?: boolean | undefined;
}, {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
    is_terminal?: boolean | undefined;
}>, "many">;
declare const apiPatternSchema: z.ZodObject<{
    id: z.ZodString;
    line_id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    names: z.ZodOptional<z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>>;
    stop_ids: z.ZodArray<z.ZodString, "many">;
    origin_stop_id: z.ZodString;
    terminal_stop_id: z.ZodString;
    is_primary: z.ZodBoolean;
    junction_stop_id: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    line_id: string;
    stop_ids: string[];
    origin_stop_id: string;
    terminal_stop_id: string;
    is_primary: boolean;
    name?: string | undefined;
    names?: {
        zh: string;
        en: string;
    } | undefined;
    color?: string | undefined;
    junction_stop_id?: string | undefined;
}, {
    id: string;
    line_id: string;
    stop_ids: string[];
    origin_stop_id: string;
    terminal_stop_id: string;
    is_primary: boolean;
    name?: string | undefined;
    names?: {
        zh: string;
        en: string;
    } | undefined;
    color?: string | undefined;
    junction_stop_id?: string | undefined;
}>;
declare const apiPatternListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    line_id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    names: z.ZodOptional<z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>>;
    stop_ids: z.ZodArray<z.ZodString, "many">;
    origin_stop_id: z.ZodString;
    terminal_stop_id: z.ZodString;
    is_primary: z.ZodBoolean;
    junction_stop_id: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    line_id: string;
    stop_ids: string[];
    origin_stop_id: string;
    terminal_stop_id: string;
    is_primary: boolean;
    name?: string | undefined;
    names?: {
        zh: string;
        en: string;
    } | undefined;
    color?: string | undefined;
    junction_stop_id?: string | undefined;
}, {
    id: string;
    line_id: string;
    stop_ids: string[];
    origin_stop_id: string;
    terminal_stop_id: string;
    is_primary: boolean;
    name?: string | undefined;
    names?: {
        zh: string;
        en: string;
    } | undefined;
    color?: string | undefined;
    junction_stop_id?: string | undefined;
}>, "many">;
declare const apiSegmentDirectionSchema: z.ZodEnum<["both", "forward", "backward"]>;
declare const apiTravelTimeSourceSchema: z.ZodEnum<["source", "last_train", "estimated"]>;
declare const apiSegmentSchema: z.ZodObject<{
    id: z.ZodString;
    line_id: z.ZodString;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    direction: z.ZodEnum<["both", "forward", "backward"]>;
    travel_time_seconds: z.ZodOptional<z.ZodNumber>;
    travel_time_source: z.ZodOptional<z.ZodEnum<["source", "last_train", "estimated"]>>;
    distance_km: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    line_id: string;
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    direction: "both" | "forward" | "backward";
    travel_time_seconds?: number | undefined;
    travel_time_source?: "last_train" | "source" | "estimated" | undefined;
    distance_km?: number | undefined;
}, {
    id: string;
    line_id: string;
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    direction: "both" | "forward" | "backward";
    travel_time_seconds?: number | undefined;
    travel_time_source?: "last_train" | "source" | "estimated" | undefined;
    distance_km?: number | undefined;
}>;
declare const apiSegmentListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    line_id: z.ZodString;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    direction: z.ZodEnum<["both", "forward", "backward"]>;
    travel_time_seconds: z.ZodOptional<z.ZodNumber>;
    travel_time_source: z.ZodOptional<z.ZodEnum<["source", "last_train", "estimated"]>>;
    distance_km: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    line_id: string;
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    direction: "both" | "forward" | "backward";
    travel_time_seconds?: number | undefined;
    travel_time_source?: "last_train" | "source" | "estimated" | undefined;
    distance_km?: number | undefined;
}, {
    id: string;
    line_id: string;
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    direction: "both" | "forward" | "backward";
    travel_time_seconds?: number | undefined;
    travel_time_source?: "last_train" | "source" | "estimated" | undefined;
    distance_km?: number | undefined;
}>, "many">;
declare const apiTransferSchema: z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    from_line_id: z.ZodString;
    to_line_id: z.ZodString;
    from_stop_id: z.ZodOptional<z.ZodString>;
    to_stop_id: z.ZodOptional<z.ZodString>;
    walk_time_seconds: z.ZodOptional<z.ZodNumber>;
    walk_distance_meters: z.ZodOptional<z.ZodNumber>;
    is_out_of_station: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    from_line_id: string;
    to_line_id: string;
    from_stop_id?: string | undefined;
    to_stop_id?: string | undefined;
    walk_time_seconds?: number | undefined;
    walk_distance_meters?: number | undefined;
    is_out_of_station?: boolean | undefined;
}, {
    id: string;
    station_id: string;
    from_line_id: string;
    to_line_id: string;
    from_stop_id?: string | undefined;
    to_stop_id?: string | undefined;
    walk_time_seconds?: number | undefined;
    walk_distance_meters?: number | undefined;
    is_out_of_station?: boolean | undefined;
}>;
declare const apiTransferListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    from_line_id: z.ZodString;
    to_line_id: z.ZodString;
    from_stop_id: z.ZodOptional<z.ZodString>;
    to_stop_id: z.ZodOptional<z.ZodString>;
    walk_time_seconds: z.ZodOptional<z.ZodNumber>;
    walk_distance_meters: z.ZodOptional<z.ZodNumber>;
    is_out_of_station: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    from_line_id: string;
    to_line_id: string;
    from_stop_id?: string | undefined;
    to_stop_id?: string | undefined;
    walk_time_seconds?: number | undefined;
    walk_distance_meters?: number | undefined;
    is_out_of_station?: boolean | undefined;
}, {
    id: string;
    station_id: string;
    from_line_id: string;
    to_line_id: string;
    from_stop_id?: string | undefined;
    to_stop_id?: string | undefined;
    walk_time_seconds?: number | undefined;
    walk_distance_meters?: number | undefined;
    is_out_of_station?: boolean | undefined;
}>, "many">;
declare const apiTimetableSchema: z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    stop_id: z.ZodString;
    line_id: z.ZodString;
    destination_stop_id: z.ZodOptional<z.ZodString>;
    origin_stop_id: z.ZodOptional<z.ZodString>;
    pattern_id: z.ZodString;
    direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
    direction_label: z.ZodOptional<z.ZodString>;
    first_train: z.ZodArray<z.ZodString, "many">;
    last_train: z.ZodArray<z.ZodString, "many">;
    is_arrival: z.ZodOptional<z.ZodBoolean>;
    service: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    line_id: string;
    first_train: string[];
    last_train: string[];
    stop_id: string;
    pattern_id: string;
    destination_stop_id?: string | undefined;
    origin_stop_id?: string | undefined;
    direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
    direction_label?: string | undefined;
    is_arrival?: boolean | undefined;
    service?: string | undefined;
}, {
    id: string;
    station_id: string;
    line_id: string;
    first_train: string[];
    last_train: string[];
    stop_id: string;
    pattern_id: string;
    destination_stop_id?: string | undefined;
    origin_stop_id?: string | undefined;
    direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
    direction_label?: string | undefined;
    is_arrival?: boolean | undefined;
    service?: string | undefined;
}>;
declare const apiTimetableListSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    stop_id: z.ZodString;
    line_id: z.ZodString;
    destination_stop_id: z.ZodOptional<z.ZodString>;
    origin_stop_id: z.ZodOptional<z.ZodString>;
    pattern_id: z.ZodString;
    direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
    direction_label: z.ZodOptional<z.ZodString>;
    first_train: z.ZodArray<z.ZodString, "many">;
    last_train: z.ZodArray<z.ZodString, "many">;
    is_arrival: z.ZodOptional<z.ZodBoolean>;
    service: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    line_id: string;
    first_train: string[];
    last_train: string[];
    stop_id: string;
    pattern_id: string;
    destination_stop_id?: string | undefined;
    origin_stop_id?: string | undefined;
    direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
    direction_label?: string | undefined;
    is_arrival?: boolean | undefined;
    service?: string | undefined;
}, {
    id: string;
    station_id: string;
    line_id: string;
    first_train: string[];
    last_train: string[];
    stop_id: string;
    pattern_id: string;
    destination_stop_id?: string | undefined;
    origin_stop_id?: string | undefined;
    direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
    direction_label?: string | undefined;
    is_arrival?: boolean | undefined;
    service?: string | undefined;
}>, "many">;
declare const apiStationDetailSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    location: z.ZodOptional<z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>>;
    schematic: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>>;
    status: z.ZodArray<z.ZodObject<{
        timetable_id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
        destination_stop_id: z.ZodOptional<z.ZodString>;
        is_in_service: z.ZodBoolean;
        first_train: z.ZodString;
        last_train: z.ZodString;
        timezone: z.ZodString;
        now: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }, {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }>, "many">;
    lines: z.ZodArray<z.ZodString, "many">;
    is_interchange: z.ZodBoolean;
    transfers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        from_line_id: z.ZodString;
        to_line_id: z.ZodString;
        from_stop_id: z.ZodOptional<z.ZodString>;
        to_stop_id: z.ZodOptional<z.ZodString>;
        walk_time_seconds: z.ZodOptional<z.ZodNumber>;
        walk_distance_meters: z.ZodOptional<z.ZodNumber>;
        is_out_of_station: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }>, "many">;
    timetables: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        stop_id: z.ZodString;
        line_id: z.ZodString;
        destination_stop_id: z.ZodOptional<z.ZodString>;
        origin_stop_id: z.ZodOptional<z.ZodString>;
        pattern_id: z.ZodString;
        direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
        direction_label: z.ZodOptional<z.ZodString>;
        first_train: z.ZodArray<z.ZodString, "many">;
        last_train: z.ZodArray<z.ZodString, "many">;
        is_arrival: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    status: {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }[];
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    transfers: {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }[];
    timetables: {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }[];
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}, {
    status: {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }[];
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    lines: string[];
    is_interchange: boolean;
    transfers: {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }[];
    timetables: {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }[];
    schematic?: {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    } | undefined;
    location?: {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    } | undefined;
}>;
declare const apiFareMatrixSchema: z.ZodObject<{
    currency: z.ZodString;
    unit: z.ZodString;
    station_ids: z.ZodArray<z.ZodString, "many">;
    fares: z.ZodArray<z.ZodArray<z.ZodUnion<[z.ZodNumber, z.ZodNull]>, "many">, "many">;
}, "strip", z.ZodTypeAny, {
    currency: string;
    unit: string;
    station_ids: string[];
    fares: (number | null)[][];
}, {
    currency: string;
    unit: string;
    station_ids: string[];
    fares: (number | null)[][];
}>;
declare const apiFareRowSchema: z.ZodObject<{
    from_station_id: z.ZodString;
    currency: z.ZodString;
    unit: z.ZodString;
    fares: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
}, "strip", z.ZodTypeAny, {
    from_station_id: string;
    currency: string;
    unit: string;
    fares: Record<string, number | null>;
}, {
    from_station_id: string;
    currency: string;
    unit: string;
    fares: Record<string, number | null>;
}>;
declare const apiCitySchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    country: z.ZodString;
    population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
    area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
    location: z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"Point">;
        coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
    }, "strip", z.ZodTypeAny, {
        type: "Point";
        coordinates: [number, number];
    }, {
        type: "Point";
        coordinates: [number, number];
    }>, z.ZodNull]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: {
        zh: string;
        en: string;
    };
    location: {
        type: "Point";
        coordinates: [number, number];
    } | null;
    country: string;
    population: number | null;
    area: number | null;
}, {
    id: string;
    name: {
        zh: string;
        en: string;
    };
    location: {
        type: "Point";
        coordinates: [number, number];
    } | null;
    country: string;
    population: number | null;
    area: number | null;
}>;
declare const apiRoutingDefaultsSchema: z.ZodObject<{
    weight: z.ZodEnum<["time", "distance"]>;
    default_transfer_seconds: z.ZodNumber;
    max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    weight: "time" | "distance";
    default_transfer_seconds: number;
    max_transfer_seconds?: number | undefined;
}, {
    weight: "time" | "distance";
    default_transfer_seconds: number;
    max_transfer_seconds?: number | undefined;
}>;
declare const apiNetworkSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    names: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    city: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        country: z.ZodString;
        population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        location: z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"Point">;
            coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        }, "strip", z.ZodTypeAny, {
            type: "Point";
            coordinates: [number, number];
        }, {
            type: "Point";
            coordinates: [number, number];
        }>, z.ZodNull]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    }, {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    }>;
    country_code: z.ZodString;
    currency: z.ZodString;
    timezone: z.ZodString;
    coordinate_system: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    default_units: z.ZodObject<{
        distance: z.ZodString;
        time: z.ZodString;
        speed: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        time: string;
        distance: string;
        speed: string;
    }, {
        time: string;
        distance: string;
        speed: string;
    }>;
    routing: z.ZodObject<{
        weight: z.ZodEnum<["time", "distance"]>;
        default_transfer_seconds: z.ZodNumber;
        max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }>;
    synced_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    timezone: string;
    currency: string;
    city: {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    };
    country_code: string;
    coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    default_units: {
        time: string;
        distance: string;
        speed: string;
    };
    routing: {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    };
    synced_at?: string | undefined;
}, {
    id: string;
    name: string;
    names: {
        zh: string;
        en: string;
    };
    timezone: string;
    currency: string;
    city: {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    };
    country_code: string;
    coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    default_units: {
        time: string;
        distance: string;
        speed: string;
    };
    routing: {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    };
    synced_at?: string | undefined;
}>;
declare const apiNetworkListSchema: z.ZodObject<{
    networks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        city: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodObject<{
                zh: z.ZodString;
                en: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                zh: string;
                en: string;
            }, {
                zh: string;
                en: string;
            }>;
            country: z.ZodString;
            population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
            area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
            location: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"Point">;
                coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
            }, "strip", z.ZodTypeAny, {
                type: "Point";
                coordinates: [number, number];
            }, {
                type: "Point";
                coordinates: [number, number];
            }>, z.ZodNull]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        }, {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        }>;
        country_code: z.ZodString;
        currency: z.ZodString;
        timezone: z.ZodString;
        coordinate_system: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        default_units: z.ZodObject<{
            distance: z.ZodString;
            time: z.ZodString;
            speed: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            time: string;
            distance: string;
            speed: string;
        }, {
            time: string;
            distance: string;
            speed: string;
        }>;
        routing: z.ZodObject<{
            weight: z.ZodEnum<["time", "distance"]>;
            default_transfer_seconds: z.ZodNumber;
            max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }>;
        synced_at: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }, {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    networks: {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }[];
}, {
    networks: {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }[];
}>;
declare const apiStopNodeSchema: z.ZodObject<{
    id: z.ZodString;
    station_id: z.ZodString;
    line_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    station_id: string;
    line_id: string;
}, {
    id: string;
    station_id: string;
    line_id: string;
}>;
declare const apiStopEdgeSchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    kind: z.ZodEnum<["ride", "transfer"]>;
    line_id: z.ZodOptional<z.ZodString>;
    seconds: z.ZodOptional<z.ZodNumber>;
    distance_km: z.ZodOptional<z.ZodNumber>;
    weight: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    from: string;
    to: string;
    kind: "ride" | "transfer";
    line_id?: string | undefined;
    distance_km?: number | undefined;
    weight?: number | undefined;
    seconds?: number | undefined;
}, {
    from: string;
    to: string;
    kind: "ride" | "transfer";
    line_id?: string | undefined;
    distance_km?: number | undefined;
    weight?: number | undefined;
    seconds?: number | undefined;
}>;
declare const apiStopGraphSchema: z.ZodObject<{
    network_id: z.ZodString;
    weight: z.ZodEnum<["seconds", "km"]>;
    routing: z.ZodObject<{
        weight: z.ZodEnum<["time", "distance"]>;
        default_transfer_seconds: z.ZodNumber;
        max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }>;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
    }, {
        id: string;
        station_id: string;
        line_id: string;
    }>, "many">;
    edges: z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        kind: z.ZodEnum<["ride", "transfer"]>;
        line_id: z.ZodOptional<z.ZodString>;
        seconds: z.ZodOptional<z.ZodNumber>;
        distance_km: z.ZodOptional<z.ZodNumber>;
        weight: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }, {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    weight: "seconds" | "km";
    routing: {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    };
    network_id: string;
    nodes: {
        id: string;
        station_id: string;
        line_id: string;
    }[];
    edges: {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }[];
}, {
    weight: "seconds" | "km";
    routing: {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    };
    network_id: string;
    nodes: {
        id: string;
        station_id: string;
        line_id: string;
    }[];
    edges: {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }[];
}>;
declare const apiRideLegSchema: z.ZodObject<{
    kind: z.ZodLiteral<"ride">;
    line_id: z.ZodOptional<z.ZodString>;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    seconds: z.ZodNumber;
    station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    pattern_id: z.ZodOptional<z.ZodString>;
    headsign_station_id: z.ZodOptional<z.ZodString>;
    headsign_names: z.ZodOptional<z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>>;
}, "strip", z.ZodTypeAny, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "ride";
    seconds: number;
    line_id?: string | undefined;
    pattern_id?: string | undefined;
    station_ids?: string[] | undefined;
    headsign_station_id?: string | undefined;
    headsign_names?: {
        zh: string;
        en: string;
    } | undefined;
}, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "ride";
    seconds: number;
    line_id?: string | undefined;
    pattern_id?: string | undefined;
    station_ids?: string[] | undefined;
    headsign_station_id?: string | undefined;
    headsign_names?: {
        zh: string;
        en: string;
    } | undefined;
}>;
declare const apiTransferLegSchema: z.ZodObject<{
    kind: z.ZodLiteral<"transfer">;
    line_id: z.ZodOptional<z.ZodString>;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    seconds: z.ZodNumber;
    same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "transfer";
    seconds: number;
    line_id?: string | undefined;
    same_line_direction_change?: boolean | undefined;
}, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "transfer";
    seconds: number;
    line_id?: string | undefined;
    same_line_direction_change?: boolean | undefined;
}>;
declare const apiRouteLegSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"ride">;
    line_id: z.ZodOptional<z.ZodString>;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    seconds: z.ZodNumber;
    station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    pattern_id: z.ZodOptional<z.ZodString>;
    headsign_station_id: z.ZodOptional<z.ZodString>;
    headsign_names: z.ZodOptional<z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>>;
}, "strip", z.ZodTypeAny, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "ride";
    seconds: number;
    line_id?: string | undefined;
    pattern_id?: string | undefined;
    station_ids?: string[] | undefined;
    headsign_station_id?: string | undefined;
    headsign_names?: {
        zh: string;
        en: string;
    } | undefined;
}, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "ride";
    seconds: number;
    line_id?: string | undefined;
    pattern_id?: string | undefined;
    station_ids?: string[] | undefined;
    headsign_station_id?: string | undefined;
    headsign_names?: {
        zh: string;
        en: string;
    } | undefined;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"transfer">;
    line_id: z.ZodOptional<z.ZodString>;
    from_stop_id: z.ZodString;
    to_stop_id: z.ZodString;
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    seconds: z.ZodNumber;
    same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "transfer";
    seconds: number;
    line_id?: string | undefined;
    same_line_direction_change?: boolean | undefined;
}, {
    from_stop_id: string;
    to_stop_id: string;
    from_station_id: string;
    to_station_id: string;
    kind: "transfer";
    seconds: number;
    line_id?: string | undefined;
    same_line_direction_change?: boolean | undefined;
}>]>;
declare const apiRoutePlanSchema: z.ZodObject<{
    from_station_id: z.ZodString;
    to_station_id: z.ZodString;
    total_seconds: z.ZodNumber;
    transfers: z.ZodNumber;
    legs: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"ride">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pattern_id: z.ZodOptional<z.ZodString>;
        headsign_station_id: z.ZodOptional<z.ZodString>;
        headsign_names: z.ZodOptional<z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"transfer">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }>]>, "many">;
    fare: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
    currency: z.ZodUnion<[z.ZodString, z.ZodNull]>;
}, "strip", z.ZodTypeAny, {
    from_station_id: string;
    to_station_id: string;
    transfers: number;
    currency: string | null;
    total_seconds: number;
    legs: ({
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    } | {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    })[];
    fare: number | null;
}, {
    from_station_id: string;
    to_station_id: string;
    transfers: number;
    currency: string | null;
    total_seconds: number;
    legs: ({
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    } | {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    })[];
    fare: number | null;
}>;
declare const apiTravelTimeEntrySchema: z.ZodObject<{
    station_id: z.ZodString;
    seconds: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    station_id: string;
    seconds: number;
}, {
    station_id: string;
    seconds: number;
}>;
declare const apiTravelTimesSchema: z.ZodObject<{
    from_station_id: z.ZodString;
    weight: z.ZodEnum<["seconds", "km"]>;
    within: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
    stations: z.ZodArray<z.ZodObject<{
        station_id: z.ZodString;
        seconds: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        station_id: string;
        seconds: number;
    }, {
        station_id: string;
        seconds: number;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    from_station_id: string;
    weight: "seconds" | "km";
    within: number | null;
    stations: {
        station_id: string;
        seconds: number;
    }[];
}, {
    from_station_id: string;
    weight: "seconds" | "km";
    within: number | null;
    stations: {
        station_id: string;
        seconds: number;
    }[];
}>;
declare const apiNearestStationSchema: z.ZodObject<{
    station_id: z.ZodString;
    distance_km: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    station_id: string;
    distance_km: number;
}, {
    station_id: string;
    distance_km: number;
}>;
declare const apiNearestStationsSchema: z.ZodObject<{
    network_id: z.ZodString;
    query: z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
    }, {
        lon: number;
        lat: number;
    }>;
    stations: z.ZodArray<z.ZodObject<{
        station_id: z.ZodString;
        distance_km: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        station_id: string;
        distance_km: number;
    }, {
        station_id: string;
        distance_km: number;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    network_id: string;
    stations: {
        station_id: string;
        distance_km: number;
    }[];
    query: {
        lon: number;
        lat: number;
    };
}, {
    network_id: string;
    stations: {
        station_id: string;
        distance_km: number;
    }[];
    query: {
        lon: number;
        lat: number;
    };
}>;
declare const apiHealthSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
}, "strip", z.ZodTypeAny, {
    status: "ok";
}, {
    status: "ok";
}>;
declare const apiErrorSchema: z.ZodObject<{
    error: z.ZodString;
}, "strip", z.ZodTypeAny, {
    error: string;
}, {
    error: string;
}>;
/** Every generated schema, keyed by its wire name. */
declare const apiSchemas: {
    ApiCrs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    ApiNames: z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        zh: string;
        en: string;
    }, {
        zh: string;
        en: string;
    }>;
    ApiGeoPoint: z.ZodObject<{
        lon: z.ZodNumber;
        lat: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }, {
        lon: number;
        lat: number;
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
    }>;
    ApiSchematicPoint: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
    }, "strip", z.ZodTypeAny, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }, {
        crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        x: number;
        y: number;
    }>;
    ApiLineMode: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
    ApiLineStatus: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
    ApiLine: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        color: z.ZodOptional<z.ZodString>;
        text_color: z.ZodOptional<z.ZodString>;
        short_name: z.ZodString;
        mode: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
        status: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
        loop: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        short_name: string;
        mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
        loop: boolean;
        color?: string | undefined;
        text_color?: string | undefined;
    }, {
        status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        short_name: string;
        mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
        loop: boolean;
        color?: string | undefined;
        text_color?: string | undefined;
    }>;
    ApiLineList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        color: z.ZodOptional<z.ZodString>;
        text_color: z.ZodOptional<z.ZodString>;
        short_name: z.ZodString;
        mode: z.ZodEnum<["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]>;
        status: z.ZodEnum<["operating", "partially_operating", "under_construction", "planned", "closed"]>;
        loop: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        short_name: string;
        mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
        loop: boolean;
        color?: string | undefined;
        text_color?: string | undefined;
    }, {
        status: "operating" | "partially_operating" | "under_construction" | "planned" | "closed";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        short_name: string;
        mode: "metro" | "suburban_rail" | "light_rail" | "tram" | "monorail" | "airport_express" | "other";
        loop: boolean;
        color?: string | undefined;
        text_color?: string | undefined;
    }>, "many">;
    ApiStationStatus: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
    ApiStation: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        location: z.ZodOptional<z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }>>;
        schematic: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }>>;
        status: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
        lines: z.ZodArray<z.ZodString, "many">;
        is_interchange: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }, {
        status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }>;
    ApiStationList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        location: z.ZodOptional<z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }>>;
        schematic: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }>>;
        status: z.ZodEnum<["operating", "out_of_service", "closed", "under_construction", "planned"]>;
        lines: z.ZodArray<z.ZodString, "many">;
        is_interchange: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }, {
        status: "operating" | "under_construction" | "planned" | "closed" | "out_of_service";
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }>, "many">;
    ApiDirectionType: z.ZodEnum<["linear", "loop_inner", "loop_outer"]>;
    ApiTimetableStatus: z.ZodObject<{
        timetable_id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
        destination_stop_id: z.ZodOptional<z.ZodString>;
        is_in_service: z.ZodBoolean;
        first_train: z.ZodString;
        last_train: z.ZodString;
        timezone: z.ZodString;
        now: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }, {
        timetable_id: string;
        station_id: string;
        line_id: string;
        is_in_service: boolean;
        first_train: string;
        last_train: string;
        timezone: string;
        now: string;
        destination_stop_id?: string | undefined;
    }>;
    ApiStop: z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
        sequence: z.ZodNumber;
        is_terminal: z.ZodOptional<z.ZodBoolean>;
        location: z.ZodOptional<z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }>>;
        schematic: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
        sequence: number;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
        is_terminal?: boolean | undefined;
    }, {
        id: string;
        station_id: string;
        line_id: string;
        sequence: number;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
        is_terminal?: boolean | undefined;
    }>;
    ApiStopList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
        sequence: z.ZodNumber;
        is_terminal: z.ZodOptional<z.ZodBoolean>;
        location: z.ZodOptional<z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }>>;
        schematic: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
        sequence: number;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
        is_terminal?: boolean | undefined;
    }, {
        id: string;
        station_id: string;
        line_id: string;
        sequence: number;
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
        is_terminal?: boolean | undefined;
    }>, "many">;
    ApiPattern: z.ZodObject<{
        id: z.ZodString;
        line_id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        names: z.ZodOptional<z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>>;
        stop_ids: z.ZodArray<z.ZodString, "many">;
        origin_stop_id: z.ZodString;
        terminal_stop_id: z.ZodString;
        is_primary: z.ZodBoolean;
        junction_stop_id: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        line_id: string;
        stop_ids: string[];
        origin_stop_id: string;
        terminal_stop_id: string;
        is_primary: boolean;
        name?: string | undefined;
        names?: {
            zh: string;
            en: string;
        } | undefined;
        color?: string | undefined;
        junction_stop_id?: string | undefined;
    }, {
        id: string;
        line_id: string;
        stop_ids: string[];
        origin_stop_id: string;
        terminal_stop_id: string;
        is_primary: boolean;
        name?: string | undefined;
        names?: {
            zh: string;
            en: string;
        } | undefined;
        color?: string | undefined;
        junction_stop_id?: string | undefined;
    }>;
    ApiPatternList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        line_id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        names: z.ZodOptional<z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>>;
        stop_ids: z.ZodArray<z.ZodString, "many">;
        origin_stop_id: z.ZodString;
        terminal_stop_id: z.ZodString;
        is_primary: z.ZodBoolean;
        junction_stop_id: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        line_id: string;
        stop_ids: string[];
        origin_stop_id: string;
        terminal_stop_id: string;
        is_primary: boolean;
        name?: string | undefined;
        names?: {
            zh: string;
            en: string;
        } | undefined;
        color?: string | undefined;
        junction_stop_id?: string | undefined;
    }, {
        id: string;
        line_id: string;
        stop_ids: string[];
        origin_stop_id: string;
        terminal_stop_id: string;
        is_primary: boolean;
        name?: string | undefined;
        names?: {
            zh: string;
            en: string;
        } | undefined;
        color?: string | undefined;
        junction_stop_id?: string | undefined;
    }>, "many">;
    ApiSegmentDirection: z.ZodEnum<["both", "forward", "backward"]>;
    ApiTravelTimeSource: z.ZodEnum<["source", "last_train", "estimated"]>;
    ApiSegment: z.ZodObject<{
        id: z.ZodString;
        line_id: z.ZodString;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        direction: z.ZodEnum<["both", "forward", "backward"]>;
        travel_time_seconds: z.ZodOptional<z.ZodNumber>;
        travel_time_source: z.ZodOptional<z.ZodEnum<["source", "last_train", "estimated"]>>;
        distance_km: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        line_id: string;
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        direction: "both" | "forward" | "backward";
        travel_time_seconds?: number | undefined;
        travel_time_source?: "last_train" | "source" | "estimated" | undefined;
        distance_km?: number | undefined;
    }, {
        id: string;
        line_id: string;
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        direction: "both" | "forward" | "backward";
        travel_time_seconds?: number | undefined;
        travel_time_source?: "last_train" | "source" | "estimated" | undefined;
        distance_km?: number | undefined;
    }>;
    ApiSegmentList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        line_id: z.ZodString;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        direction: z.ZodEnum<["both", "forward", "backward"]>;
        travel_time_seconds: z.ZodOptional<z.ZodNumber>;
        travel_time_source: z.ZodOptional<z.ZodEnum<["source", "last_train", "estimated"]>>;
        distance_km: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        line_id: string;
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        direction: "both" | "forward" | "backward";
        travel_time_seconds?: number | undefined;
        travel_time_source?: "last_train" | "source" | "estimated" | undefined;
        distance_km?: number | undefined;
    }, {
        id: string;
        line_id: string;
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        direction: "both" | "forward" | "backward";
        travel_time_seconds?: number | undefined;
        travel_time_source?: "last_train" | "source" | "estimated" | undefined;
        distance_km?: number | undefined;
    }>, "many">;
    ApiTransfer: z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        from_line_id: z.ZodString;
        to_line_id: z.ZodString;
        from_stop_id: z.ZodOptional<z.ZodString>;
        to_stop_id: z.ZodOptional<z.ZodString>;
        walk_time_seconds: z.ZodOptional<z.ZodNumber>;
        walk_distance_meters: z.ZodOptional<z.ZodNumber>;
        is_out_of_station: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }>;
    ApiTransferList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        from_line_id: z.ZodString;
        to_line_id: z.ZodString;
        from_stop_id: z.ZodOptional<z.ZodString>;
        to_stop_id: z.ZodOptional<z.ZodString>;
        walk_time_seconds: z.ZodOptional<z.ZodNumber>;
        walk_distance_meters: z.ZodOptional<z.ZodNumber>;
        is_out_of_station: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }, {
        id: string;
        station_id: string;
        from_line_id: string;
        to_line_id: string;
        from_stop_id?: string | undefined;
        to_stop_id?: string | undefined;
        walk_time_seconds?: number | undefined;
        walk_distance_meters?: number | undefined;
        is_out_of_station?: boolean | undefined;
    }>, "many">;
    ApiTimetable: z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        stop_id: z.ZodString;
        line_id: z.ZodString;
        destination_stop_id: z.ZodOptional<z.ZodString>;
        origin_stop_id: z.ZodOptional<z.ZodString>;
        pattern_id: z.ZodString;
        direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
        direction_label: z.ZodOptional<z.ZodString>;
        first_train: z.ZodArray<z.ZodString, "many">;
        last_train: z.ZodArray<z.ZodString, "many">;
        is_arrival: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }>;
    ApiTimetableList: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        stop_id: z.ZodString;
        line_id: z.ZodString;
        destination_stop_id: z.ZodOptional<z.ZodString>;
        origin_stop_id: z.ZodOptional<z.ZodString>;
        pattern_id: z.ZodString;
        direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
        direction_label: z.ZodOptional<z.ZodString>;
        first_train: z.ZodArray<z.ZodString, "many">;
        last_train: z.ZodArray<z.ZodString, "many">;
        is_arrival: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }, {
        id: string;
        station_id: string;
        line_id: string;
        first_train: string[];
        last_train: string[];
        stop_id: string;
        pattern_id: string;
        destination_stop_id?: string | undefined;
        origin_stop_id?: string | undefined;
        direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
        direction_label?: string | undefined;
        is_arrival?: boolean | undefined;
        service?: string | undefined;
    }>, "many">;
    ApiStationDetail: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        location: z.ZodOptional<z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }, {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        }>>;
        schematic: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            crs: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        }, "strip", z.ZodTypeAny, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }, {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        }>>;
        status: z.ZodArray<z.ZodObject<{
            timetable_id: z.ZodString;
            station_id: z.ZodString;
            line_id: z.ZodString;
            destination_stop_id: z.ZodOptional<z.ZodString>;
            is_in_service: z.ZodBoolean;
            first_train: z.ZodString;
            last_train: z.ZodString;
            timezone: z.ZodString;
            now: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            timetable_id: string;
            station_id: string;
            line_id: string;
            is_in_service: boolean;
            first_train: string;
            last_train: string;
            timezone: string;
            now: string;
            destination_stop_id?: string | undefined;
        }, {
            timetable_id: string;
            station_id: string;
            line_id: string;
            is_in_service: boolean;
            first_train: string;
            last_train: string;
            timezone: string;
            now: string;
            destination_stop_id?: string | undefined;
        }>, "many">;
        lines: z.ZodArray<z.ZodString, "many">;
        is_interchange: z.ZodBoolean;
        transfers: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            station_id: z.ZodString;
            from_line_id: z.ZodString;
            to_line_id: z.ZodString;
            from_stop_id: z.ZodOptional<z.ZodString>;
            to_stop_id: z.ZodOptional<z.ZodString>;
            walk_time_seconds: z.ZodOptional<z.ZodNumber>;
            walk_distance_meters: z.ZodOptional<z.ZodNumber>;
            is_out_of_station: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            station_id: string;
            from_line_id: string;
            to_line_id: string;
            from_stop_id?: string | undefined;
            to_stop_id?: string | undefined;
            walk_time_seconds?: number | undefined;
            walk_distance_meters?: number | undefined;
            is_out_of_station?: boolean | undefined;
        }, {
            id: string;
            station_id: string;
            from_line_id: string;
            to_line_id: string;
            from_stop_id?: string | undefined;
            to_stop_id?: string | undefined;
            walk_time_seconds?: number | undefined;
            walk_distance_meters?: number | undefined;
            is_out_of_station?: boolean | undefined;
        }>, "many">;
        timetables: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            station_id: z.ZodString;
            stop_id: z.ZodString;
            line_id: z.ZodString;
            destination_stop_id: z.ZodOptional<z.ZodString>;
            origin_stop_id: z.ZodOptional<z.ZodString>;
            pattern_id: z.ZodString;
            direction_type: z.ZodOptional<z.ZodEnum<["linear", "loop_inner", "loop_outer"]>>;
            direction_label: z.ZodOptional<z.ZodString>;
            first_train: z.ZodArray<z.ZodString, "many">;
            last_train: z.ZodArray<z.ZodString, "many">;
            is_arrival: z.ZodOptional<z.ZodBoolean>;
            service: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            station_id: string;
            line_id: string;
            first_train: string[];
            last_train: string[];
            stop_id: string;
            pattern_id: string;
            destination_stop_id?: string | undefined;
            origin_stop_id?: string | undefined;
            direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
            direction_label?: string | undefined;
            is_arrival?: boolean | undefined;
            service?: string | undefined;
        }, {
            id: string;
            station_id: string;
            line_id: string;
            first_train: string[];
            last_train: string[];
            stop_id: string;
            pattern_id: string;
            destination_stop_id?: string | undefined;
            origin_stop_id?: string | undefined;
            direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
            direction_label?: string | undefined;
            is_arrival?: boolean | undefined;
            service?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        status: {
            timetable_id: string;
            station_id: string;
            line_id: string;
            is_in_service: boolean;
            first_train: string;
            last_train: string;
            timezone: string;
            now: string;
            destination_stop_id?: string | undefined;
        }[];
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        transfers: {
            id: string;
            station_id: string;
            from_line_id: string;
            to_line_id: string;
            from_stop_id?: string | undefined;
            to_stop_id?: string | undefined;
            walk_time_seconds?: number | undefined;
            walk_distance_meters?: number | undefined;
            is_out_of_station?: boolean | undefined;
        }[];
        timetables: {
            id: string;
            station_id: string;
            line_id: string;
            first_train: string[];
            last_train: string[];
            stop_id: string;
            pattern_id: string;
            destination_stop_id?: string | undefined;
            origin_stop_id?: string | undefined;
            direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
            direction_label?: string | undefined;
            is_arrival?: boolean | undefined;
            service?: string | undefined;
        }[];
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }, {
        status: {
            timetable_id: string;
            station_id: string;
            line_id: string;
            is_in_service: boolean;
            first_train: string;
            last_train: string;
            timezone: string;
            now: string;
            destination_stop_id?: string | undefined;
        }[];
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        lines: string[];
        is_interchange: boolean;
        transfers: {
            id: string;
            station_id: string;
            from_line_id: string;
            to_line_id: string;
            from_stop_id?: string | undefined;
            to_stop_id?: string | undefined;
            walk_time_seconds?: number | undefined;
            walk_distance_meters?: number | undefined;
            is_out_of_station?: boolean | undefined;
        }[];
        timetables: {
            id: string;
            station_id: string;
            line_id: string;
            first_train: string[];
            last_train: string[];
            stop_id: string;
            pattern_id: string;
            destination_stop_id?: string | undefined;
            origin_stop_id?: string | undefined;
            direction_type?: "linear" | "loop_inner" | "loop_outer" | undefined;
            direction_label?: string | undefined;
            is_arrival?: boolean | undefined;
            service?: string | undefined;
        }[];
        schematic?: {
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            x: number;
            y: number;
        } | undefined;
        location?: {
            lon: number;
            lat: number;
            crs: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        } | undefined;
    }>;
    ApiFareMatrix: z.ZodObject<{
        currency: z.ZodString;
        unit: z.ZodString;
        station_ids: z.ZodArray<z.ZodString, "many">;
        fares: z.ZodArray<z.ZodArray<z.ZodUnion<[z.ZodNumber, z.ZodNull]>, "many">, "many">;
    }, "strip", z.ZodTypeAny, {
        currency: string;
        unit: string;
        station_ids: string[];
        fares: (number | null)[][];
    }, {
        currency: string;
        unit: string;
        station_ids: string[];
        fares: (number | null)[][];
    }>;
    ApiFareRow: z.ZodObject<{
        from_station_id: z.ZodString;
        currency: z.ZodString;
        unit: z.ZodString;
        fares: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
    }, "strip", z.ZodTypeAny, {
        from_station_id: string;
        currency: string;
        unit: string;
        fares: Record<string, number | null>;
    }, {
        from_station_id: string;
        currency: string;
        unit: string;
        fares: Record<string, number | null>;
    }>;
    ApiCity: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        country: z.ZodString;
        population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        location: z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"Point">;
            coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        }, "strip", z.ZodTypeAny, {
            type: "Point";
            coordinates: [number, number];
        }, {
            type: "Point";
            coordinates: [number, number];
        }>, z.ZodNull]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    }, {
        id: string;
        name: {
            zh: string;
            en: string;
        };
        location: {
            type: "Point";
            coordinates: [number, number];
        } | null;
        country: string;
        population: number | null;
        area: number | null;
    }>;
    ApiRoutingDefaults: z.ZodObject<{
        weight: z.ZodEnum<["time", "distance"]>;
        default_transfer_seconds: z.ZodNumber;
        max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }, {
        weight: "time" | "distance";
        default_transfer_seconds: number;
        max_transfer_seconds?: number | undefined;
    }>;
    ApiNetwork: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        names: z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>;
        city: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodObject<{
                zh: z.ZodString;
                en: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                zh: string;
                en: string;
            }, {
                zh: string;
                en: string;
            }>;
            country: z.ZodString;
            population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
            area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
            location: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"Point">;
                coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
            }, "strip", z.ZodTypeAny, {
                type: "Point";
                coordinates: [number, number];
            }, {
                type: "Point";
                coordinates: [number, number];
            }>, z.ZodNull]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        }, {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        }>;
        country_code: z.ZodString;
        currency: z.ZodString;
        timezone: z.ZodString;
        coordinate_system: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
        default_units: z.ZodObject<{
            distance: z.ZodString;
            time: z.ZodString;
            speed: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            time: string;
            distance: string;
            speed: string;
        }, {
            time: string;
            distance: string;
            speed: string;
        }>;
        routing: z.ZodObject<{
            weight: z.ZodEnum<["time", "distance"]>;
            default_transfer_seconds: z.ZodNumber;
            max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }>;
        synced_at: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }, {
        id: string;
        name: string;
        names: {
            zh: string;
            en: string;
        };
        timezone: string;
        currency: string;
        city: {
            id: string;
            name: {
                zh: string;
                en: string;
            };
            location: {
                type: "Point";
                coordinates: [number, number];
            } | null;
            country: string;
            population: number | null;
            area: number | null;
        };
        country_code: string;
        coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
        default_units: {
            time: string;
            distance: string;
            speed: string;
        };
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        synced_at?: string | undefined;
    }>;
    ApiNetworkList: z.ZodObject<{
        networks: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            names: z.ZodObject<{
                zh: z.ZodString;
                en: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                zh: string;
                en: string;
            }, {
                zh: string;
                en: string;
            }>;
            city: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodObject<{
                    zh: z.ZodString;
                    en: z.ZodString;
                }, "strip", z.ZodTypeAny, {
                    zh: string;
                    en: string;
                }, {
                    zh: string;
                    en: string;
                }>;
                country: z.ZodString;
                population: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
                area: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
                location: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"Point">;
                    coordinates: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
                }, "strip", z.ZodTypeAny, {
                    type: "Point";
                    coordinates: [number, number];
                }, {
                    type: "Point";
                    coordinates: [number, number];
                }>, z.ZodNull]>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            }, {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            }>;
            country_code: z.ZodString;
            currency: z.ZodString;
            timezone: z.ZodString;
            coordinate_system: z.ZodEnum<["wgs84", "gcj02", "bd09", "schematic", "none"]>;
            default_units: z.ZodObject<{
                distance: z.ZodString;
                time: z.ZodString;
                speed: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                time: string;
                distance: string;
                speed: string;
            }, {
                time: string;
                distance: string;
                speed: string;
            }>;
            routing: z.ZodObject<{
                weight: z.ZodEnum<["time", "distance"]>;
                default_transfer_seconds: z.ZodNumber;
                max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            }, {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            }>;
            synced_at: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            name: string;
            names: {
                zh: string;
                en: string;
            };
            timezone: string;
            currency: string;
            city: {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            };
            country_code: string;
            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            default_units: {
                time: string;
                distance: string;
                speed: string;
            };
            routing: {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            };
            synced_at?: string | undefined;
        }, {
            id: string;
            name: string;
            names: {
                zh: string;
                en: string;
            };
            timezone: string;
            currency: string;
            city: {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            };
            country_code: string;
            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            default_units: {
                time: string;
                distance: string;
                speed: string;
            };
            routing: {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            };
            synced_at?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        networks: {
            id: string;
            name: string;
            names: {
                zh: string;
                en: string;
            };
            timezone: string;
            currency: string;
            city: {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            };
            country_code: string;
            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            default_units: {
                time: string;
                distance: string;
                speed: string;
            };
            routing: {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            };
            synced_at?: string | undefined;
        }[];
    }, {
        networks: {
            id: string;
            name: string;
            names: {
                zh: string;
                en: string;
            };
            timezone: string;
            currency: string;
            city: {
                id: string;
                name: {
                    zh: string;
                    en: string;
                };
                location: {
                    type: "Point";
                    coordinates: [number, number];
                } | null;
                country: string;
                population: number | null;
                area: number | null;
            };
            country_code: string;
            coordinate_system: "wgs84" | "gcj02" | "bd09" | "schematic" | "none";
            default_units: {
                time: string;
                distance: string;
                speed: string;
            };
            routing: {
                weight: "time" | "distance";
                default_transfer_seconds: number;
                max_transfer_seconds?: number | undefined;
            };
            synced_at?: string | undefined;
        }[];
    }>;
    ApiStopNode: z.ZodObject<{
        id: z.ZodString;
        station_id: z.ZodString;
        line_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        station_id: string;
        line_id: string;
    }, {
        id: string;
        station_id: string;
        line_id: string;
    }>;
    ApiStopEdge: z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        kind: z.ZodEnum<["ride", "transfer"]>;
        line_id: z.ZodOptional<z.ZodString>;
        seconds: z.ZodOptional<z.ZodNumber>;
        distance_km: z.ZodOptional<z.ZodNumber>;
        weight: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }, {
        from: string;
        to: string;
        kind: "ride" | "transfer";
        line_id?: string | undefined;
        distance_km?: number | undefined;
        weight?: number | undefined;
        seconds?: number | undefined;
    }>;
    ApiStopGraph: z.ZodObject<{
        network_id: z.ZodString;
        weight: z.ZodEnum<["seconds", "km"]>;
        routing: z.ZodObject<{
            weight: z.ZodEnum<["time", "distance"]>;
            default_transfer_seconds: z.ZodNumber;
            max_transfer_seconds: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }, {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        }>;
        nodes: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            station_id: z.ZodString;
            line_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
            station_id: string;
            line_id: string;
        }, {
            id: string;
            station_id: string;
            line_id: string;
        }>, "many">;
        edges: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
            kind: z.ZodEnum<["ride", "transfer"]>;
            line_id: z.ZodOptional<z.ZodString>;
            seconds: z.ZodOptional<z.ZodNumber>;
            distance_km: z.ZodOptional<z.ZodNumber>;
            weight: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            from: string;
            to: string;
            kind: "ride" | "transfer";
            line_id?: string | undefined;
            distance_km?: number | undefined;
            weight?: number | undefined;
            seconds?: number | undefined;
        }, {
            from: string;
            to: string;
            kind: "ride" | "transfer";
            line_id?: string | undefined;
            distance_km?: number | undefined;
            weight?: number | undefined;
            seconds?: number | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        weight: "seconds" | "km";
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        network_id: string;
        nodes: {
            id: string;
            station_id: string;
            line_id: string;
        }[];
        edges: {
            from: string;
            to: string;
            kind: "ride" | "transfer";
            line_id?: string | undefined;
            distance_km?: number | undefined;
            weight?: number | undefined;
            seconds?: number | undefined;
        }[];
    }, {
        weight: "seconds" | "km";
        routing: {
            weight: "time" | "distance";
            default_transfer_seconds: number;
            max_transfer_seconds?: number | undefined;
        };
        network_id: string;
        nodes: {
            id: string;
            station_id: string;
            line_id: string;
        }[];
        edges: {
            from: string;
            to: string;
            kind: "ride" | "transfer";
            line_id?: string | undefined;
            distance_km?: number | undefined;
            weight?: number | undefined;
            seconds?: number | undefined;
        }[];
    }>;
    ApiRideLeg: z.ZodObject<{
        kind: z.ZodLiteral<"ride">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pattern_id: z.ZodOptional<z.ZodString>;
        headsign_station_id: z.ZodOptional<z.ZodString>;
        headsign_names: z.ZodOptional<z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }>;
    ApiTransferLeg: z.ZodObject<{
        kind: z.ZodLiteral<"transfer">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }>;
    ApiRouteLeg: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"ride">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pattern_id: z.ZodOptional<z.ZodString>;
        headsign_station_id: z.ZodOptional<z.ZodString>;
        headsign_names: z.ZodOptional<z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            zh: string;
            en: string;
        }, {
            zh: string;
            en: string;
        }>>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "ride";
        seconds: number;
        line_id?: string | undefined;
        pattern_id?: string | undefined;
        station_ids?: string[] | undefined;
        headsign_station_id?: string | undefined;
        headsign_names?: {
            zh: string;
            en: string;
        } | undefined;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"transfer">;
        line_id: z.ZodOptional<z.ZodString>;
        from_stop_id: z.ZodString;
        to_stop_id: z.ZodString;
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        seconds: z.ZodNumber;
        same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }, {
        from_stop_id: string;
        to_stop_id: string;
        from_station_id: string;
        to_station_id: string;
        kind: "transfer";
        seconds: number;
        line_id?: string | undefined;
        same_line_direction_change?: boolean | undefined;
    }>]>;
    ApiRoutePlan: z.ZodObject<{
        from_station_id: z.ZodString;
        to_station_id: z.ZodString;
        total_seconds: z.ZodNumber;
        transfers: z.ZodNumber;
        legs: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
            kind: z.ZodLiteral<"ride">;
            line_id: z.ZodOptional<z.ZodString>;
            from_stop_id: z.ZodString;
            to_stop_id: z.ZodString;
            from_station_id: z.ZodString;
            to_station_id: z.ZodString;
            seconds: z.ZodNumber;
            station_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            pattern_id: z.ZodOptional<z.ZodString>;
            headsign_station_id: z.ZodOptional<z.ZodString>;
            headsign_names: z.ZodOptional<z.ZodObject<{
                zh: z.ZodString;
                en: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                zh: string;
                en: string;
            }, {
                zh: string;
                en: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "ride";
            seconds: number;
            line_id?: string | undefined;
            pattern_id?: string | undefined;
            station_ids?: string[] | undefined;
            headsign_station_id?: string | undefined;
            headsign_names?: {
                zh: string;
                en: string;
            } | undefined;
        }, {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "ride";
            seconds: number;
            line_id?: string | undefined;
            pattern_id?: string | undefined;
            station_ids?: string[] | undefined;
            headsign_station_id?: string | undefined;
            headsign_names?: {
                zh: string;
                en: string;
            } | undefined;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"transfer">;
            line_id: z.ZodOptional<z.ZodString>;
            from_stop_id: z.ZodString;
            to_stop_id: z.ZodString;
            from_station_id: z.ZodString;
            to_station_id: z.ZodString;
            seconds: z.ZodNumber;
            same_line_direction_change: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "transfer";
            seconds: number;
            line_id?: string | undefined;
            same_line_direction_change?: boolean | undefined;
        }, {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "transfer";
            seconds: number;
            line_id?: string | undefined;
            same_line_direction_change?: boolean | undefined;
        }>]>, "many">;
        fare: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        currency: z.ZodUnion<[z.ZodString, z.ZodNull]>;
    }, "strip", z.ZodTypeAny, {
        from_station_id: string;
        to_station_id: string;
        transfers: number;
        currency: string | null;
        total_seconds: number;
        legs: ({
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "ride";
            seconds: number;
            line_id?: string | undefined;
            pattern_id?: string | undefined;
            station_ids?: string[] | undefined;
            headsign_station_id?: string | undefined;
            headsign_names?: {
                zh: string;
                en: string;
            } | undefined;
        } | {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "transfer";
            seconds: number;
            line_id?: string | undefined;
            same_line_direction_change?: boolean | undefined;
        })[];
        fare: number | null;
    }, {
        from_station_id: string;
        to_station_id: string;
        transfers: number;
        currency: string | null;
        total_seconds: number;
        legs: ({
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "ride";
            seconds: number;
            line_id?: string | undefined;
            pattern_id?: string | undefined;
            station_ids?: string[] | undefined;
            headsign_station_id?: string | undefined;
            headsign_names?: {
                zh: string;
                en: string;
            } | undefined;
        } | {
            from_stop_id: string;
            to_stop_id: string;
            from_station_id: string;
            to_station_id: string;
            kind: "transfer";
            seconds: number;
            line_id?: string | undefined;
            same_line_direction_change?: boolean | undefined;
        })[];
        fare: number | null;
    }>;
    ApiTravelTimeEntry: z.ZodObject<{
        station_id: z.ZodString;
        seconds: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        station_id: string;
        seconds: number;
    }, {
        station_id: string;
        seconds: number;
    }>;
    ApiTravelTimes: z.ZodObject<{
        from_station_id: z.ZodString;
        weight: z.ZodEnum<["seconds", "km"]>;
        within: z.ZodUnion<[z.ZodNumber, z.ZodNull]>;
        stations: z.ZodArray<z.ZodObject<{
            station_id: z.ZodString;
            seconds: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            station_id: string;
            seconds: number;
        }, {
            station_id: string;
            seconds: number;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        from_station_id: string;
        weight: "seconds" | "km";
        within: number | null;
        stations: {
            station_id: string;
            seconds: number;
        }[];
    }, {
        from_station_id: string;
        weight: "seconds" | "km";
        within: number | null;
        stations: {
            station_id: string;
            seconds: number;
        }[];
    }>;
    ApiNearestStation: z.ZodObject<{
        station_id: z.ZodString;
        distance_km: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        station_id: string;
        distance_km: number;
    }, {
        station_id: string;
        distance_km: number;
    }>;
    ApiNearestStations: z.ZodObject<{
        network_id: z.ZodString;
        query: z.ZodObject<{
            lon: z.ZodNumber;
            lat: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            lon: number;
            lat: number;
        }, {
            lon: number;
            lat: number;
        }>;
        stations: z.ZodArray<z.ZodObject<{
            station_id: z.ZodString;
            distance_km: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            station_id: string;
            distance_km: number;
        }, {
            station_id: string;
            distance_km: number;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        network_id: string;
        stations: {
            station_id: string;
            distance_km: number;
        }[];
        query: {
            lon: number;
            lat: number;
        };
    }, {
        network_id: string;
        stations: {
            station_id: string;
            distance_km: number;
        }[];
        query: {
            lon: number;
            lat: number;
        };
    }>;
    ApiHealth: z.ZodObject<{
        status: z.ZodLiteral<"ok">;
    }, "strip", z.ZodTypeAny, {
        status: "ok";
    }, {
        status: "ok";
    }>;
    ApiError: z.ZodObject<{
        error: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        error: string;
    }, {
        error: string;
    }>;
};

export { apiCitySchema, apiCrsSchema, apiDirectionTypeSchema, apiErrorSchema, apiFareMatrixSchema, apiFareRowSchema, apiGeoPointSchema, apiHealthSchema, apiLineListSchema, apiLineModeSchema, apiLineSchema, apiLineStatusSchema, apiNamesSchema, apiNearestStationSchema, apiNearestStationsSchema, apiNetworkListSchema, apiNetworkSchema, apiPatternListSchema, apiPatternSchema, apiRideLegSchema, apiRouteLegSchema, apiRoutePlanSchema, apiRoutingDefaultsSchema, apiSchemas, apiSchematicPointSchema, apiSegmentDirectionSchema, apiSegmentListSchema, apiSegmentSchema, apiStationDetailSchema, apiStationListSchema, apiStationSchema, apiStationStatusSchema, apiStopEdgeSchema, apiStopGraphSchema, apiStopListSchema, apiStopNodeSchema, apiStopSchema, apiTimetableListSchema, apiTimetableSchema, apiTimetableStatusSchema, apiTransferLegSchema, apiTransferListSchema, apiTransferSchema, apiTravelTimeEntrySchema, apiTravelTimeSourceSchema, apiTravelTimesSchema };
