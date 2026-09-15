// src/schemas.generated.ts
import { z } from "zod";
var apiCrsSchema = z.enum(["wgs84", "gcj02", "bd09", "schematic", "none"]);
var apiNamesSchema = z.object({ "zh": z.string(), "en": z.string() });
var apiGeoPointSchema = z.object({ "lon": z.number(), "lat": z.number(), "crs": z.enum(["wgs84", "gcj02", "bd09", "schematic", "none"]) });
var apiSchematicPointSchema = z.object({ "x": z.number(), "y": z.number(), "crs": z.enum(["wgs84", "gcj02", "bd09", "schematic", "none"]) });
var apiLineModeSchema = z.enum(["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]);
var apiLineStatusSchema = z.enum(["operating", "partially_operating", "under_construction", "planned", "closed"]);
var apiLineSchema = z.object({ "id": z.string(), "name": z.string(), "names": apiNamesSchema, "color": z.string().optional(), "text_color": z.string().optional(), "short_name": z.string(), "mode": z.enum(["metro", "suburban_rail", "light_rail", "tram", "monorail", "airport_express", "other"]), "status": z.enum(["operating", "partially_operating", "under_construction", "planned", "closed"]), "loop": z.boolean() });
var apiLineListSchema = z.array(apiLineSchema);
var apiStationStatusSchema = z.enum(["operating", "out_of_service", "closed", "under_construction", "planned"]);
var apiStationSchema = z.object({ "id": z.string(), "name": z.string(), "names": apiNamesSchema, "location": apiGeoPointSchema.optional(), "schematic": apiSchematicPointSchema.optional(), "status": z.enum(["operating", "out_of_service", "closed", "under_construction", "planned"]), "lines": z.array(z.string()), "is_interchange": z.boolean() });
var apiStationListSchema = z.array(apiStationSchema);
var apiDirectionTypeSchema = z.enum(["linear", "loop_inner", "loop_outer"]);
var apiTimetableStatusSchema = z.object({ "timetable_id": z.string(), "station_id": z.string(), "line_id": z.string(), "destination_stop_id": z.string().optional(), "is_in_service": z.boolean(), "first_train": z.string(), "last_train": z.string(), "timezone": z.string(), "now": z.string() });
var apiStopSchema = z.object({ "id": z.string(), "station_id": z.string(), "line_id": z.string(), "sequence": z.number(), "is_terminal": z.boolean().optional(), "location": apiGeoPointSchema.optional(), "schematic": apiSchematicPointSchema.optional() });
var apiStopListSchema = z.array(apiStopSchema);
var apiPatternSchema = z.object({ "id": z.string(), "line_id": z.string(), "name": z.string().optional(), "names": apiNamesSchema.optional(), "stop_ids": z.array(z.string()), "origin_stop_id": z.string(), "terminal_stop_id": z.string(), "is_primary": z.boolean(), "junction_stop_id": z.string().optional(), "color": z.string().optional() });
var apiPatternListSchema = z.array(apiPatternSchema);
var apiSegmentDirectionSchema = z.enum(["both", "forward", "backward"]);
var apiTravelTimeSourceSchema = z.enum(["source", "last_train", "estimated"]);
var apiSegmentSchema = z.object({ "id": z.string(), "line_id": z.string(), "from_stop_id": z.string(), "to_stop_id": z.string(), "from_station_id": z.string(), "to_station_id": z.string(), "direction": z.enum(["both", "forward", "backward"]), "travel_time_seconds": z.number().optional(), "travel_time_source": apiTravelTimeSourceSchema.optional(), "distance_km": z.number().optional() });
var apiSegmentListSchema = z.array(apiSegmentSchema);
var apiTransferSchema = z.object({ "id": z.string(), "station_id": z.string(), "from_line_id": z.string(), "to_line_id": z.string(), "from_stop_id": z.string().optional(), "to_stop_id": z.string().optional(), "walk_time_seconds": z.number().optional(), "walk_distance_meters": z.number().optional(), "is_out_of_station": z.boolean().optional() });
var apiTransferListSchema = z.array(apiTransferSchema);
var apiTimetableSchema = z.object({ "id": z.string(), "station_id": z.string(), "stop_id": z.string(), "line_id": z.string(), "destination_stop_id": z.string().optional(), "origin_stop_id": z.string().optional(), "pattern_id": z.string(), "direction_type": apiDirectionTypeSchema.optional(), "direction_label": z.string().optional(), "first_train": z.array(z.string()), "last_train": z.array(z.string()), "is_arrival": z.boolean().optional(), "service": z.string().optional() });
var apiTimetableListSchema = z.array(apiTimetableSchema);
var apiStationDetailSchema = z.object({ "id": z.string(), "name": z.string(), "names": apiNamesSchema, "location": apiGeoPointSchema.optional(), "schematic": apiSchematicPointSchema.optional(), "status": z.array(apiTimetableStatusSchema), "lines": z.array(z.string()), "is_interchange": z.boolean(), "transfers": z.array(apiTransferSchema), "timetables": z.array(apiTimetableSchema) });
var apiFareMatrixSchema = z.object({ "currency": z.string(), "unit": z.string(), "station_ids": z.array(z.string()), "fares": z.array(z.array(z.union([z.number(), z.null()]))) });
var apiFareRowSchema = z.object({ "from_station_id": z.string(), "currency": z.string(), "unit": z.string(), "fares": z.record(z.string(), z.union([z.number(), z.null()])) });
var apiCitySchema = z.object({ "id": z.string(), "name": apiNamesSchema, "country": z.string(), "population": z.union([z.number(), z.null()]), "area": z.union([z.number(), z.null()]), "location": z.union([z.object({ "type": z.literal("Point"), "coordinates": z.tuple([z.number(), z.number()]) }), z.null()]) });
var apiRoutingDefaultsSchema = z.object({ "weight": z.enum(["time", "distance"]), "default_transfer_seconds": z.number(), "max_transfer_seconds": z.number().optional() });
var apiNetworkSchema = z.object({ "id": z.string(), "name": z.string(), "names": apiNamesSchema, "city": apiCitySchema, "country_code": z.string(), "currency": z.string(), "timezone": z.string(), "coordinate_system": z.enum(["wgs84", "gcj02", "bd09", "schematic", "none"]), "default_units": z.object({ "distance": z.string(), "time": z.string(), "speed": z.string() }), "routing": apiRoutingDefaultsSchema, "synced_at": z.string().optional() });
var apiNetworkListSchema = z.object({ "networks": z.array(apiNetworkSchema) });
var apiStopNodeSchema = z.object({ "id": z.string(), "station_id": z.string(), "line_id": z.string() });
var apiStopEdgeSchema = z.object({ "from": z.string(), "to": z.string(), "kind": z.enum(["ride", "transfer"]), "line_id": z.string().optional(), "seconds": z.number().optional(), "distance_km": z.number().optional(), "weight": z.number().optional() });
var apiStopGraphSchema = z.object({ "network_id": z.string(), "weight": z.enum(["seconds", "km"]), "routing": apiRoutingDefaultsSchema, "nodes": z.array(apiStopNodeSchema), "edges": z.array(apiStopEdgeSchema) });
var apiRideLegSchema = z.object({ "kind": z.literal("ride"), "line_id": z.string().optional(), "from_stop_id": z.string(), "to_stop_id": z.string(), "from_station_id": z.string(), "to_station_id": z.string(), "seconds": z.number(), "station_ids": z.array(z.string()).optional(), "pattern_id": z.string().optional(), "headsign_station_id": z.string().optional(), "headsign_names": apiNamesSchema.optional() });
var apiTransferLegSchema = z.object({ "kind": z.literal("transfer"), "line_id": z.string().optional(), "from_stop_id": z.string(), "to_stop_id": z.string(), "from_station_id": z.string(), "to_station_id": z.string(), "seconds": z.number(), "same_line_direction_change": z.boolean().optional() });
var apiRouteLegSchema = z.discriminatedUnion("kind", [apiRideLegSchema, apiTransferLegSchema]);
var apiRoutePlanSchema = z.object({ "from_station_id": z.string(), "to_station_id": z.string(), "total_seconds": z.number(), "transfers": z.number(), "legs": z.array(apiRouteLegSchema), "fare": z.union([z.number(), z.null()]), "currency": z.union([z.string(), z.null()]) });
var apiTravelTimeEntrySchema = z.object({ "station_id": z.string(), "seconds": z.number() });
var apiTravelTimesSchema = z.object({ "from_station_id": z.string(), "weight": z.enum(["seconds", "km"]), "within": z.union([z.number(), z.null()]), "stations": z.array(apiTravelTimeEntrySchema) });
var apiNearestStationSchema = z.object({ "station_id": z.string(), "distance_km": z.number() });
var apiNearestStationsSchema = z.object({ "network_id": z.string(), "query": z.object({ "lon": z.number(), "lat": z.number() }), "stations": z.array(apiNearestStationSchema) });
var apiHealthSchema = z.object({ "status": z.literal("ok") });
var apiErrorSchema = z.object({ "error": z.string() });
var apiSchemas = {
  ApiCrs: apiCrsSchema,
  ApiNames: apiNamesSchema,
  ApiGeoPoint: apiGeoPointSchema,
  ApiSchematicPoint: apiSchematicPointSchema,
  ApiLineMode: apiLineModeSchema,
  ApiLineStatus: apiLineStatusSchema,
  ApiLine: apiLineSchema,
  ApiLineList: apiLineListSchema,
  ApiStationStatus: apiStationStatusSchema,
  ApiStation: apiStationSchema,
  ApiStationList: apiStationListSchema,
  ApiDirectionType: apiDirectionTypeSchema,
  ApiTimetableStatus: apiTimetableStatusSchema,
  ApiStop: apiStopSchema,
  ApiStopList: apiStopListSchema,
  ApiPattern: apiPatternSchema,
  ApiPatternList: apiPatternListSchema,
  ApiSegmentDirection: apiSegmentDirectionSchema,
  ApiTravelTimeSource: apiTravelTimeSourceSchema,
  ApiSegment: apiSegmentSchema,
  ApiSegmentList: apiSegmentListSchema,
  ApiTransfer: apiTransferSchema,
  ApiTransferList: apiTransferListSchema,
  ApiTimetable: apiTimetableSchema,
  ApiTimetableList: apiTimetableListSchema,
  ApiStationDetail: apiStationDetailSchema,
  ApiFareMatrix: apiFareMatrixSchema,
  ApiFareRow: apiFareRowSchema,
  ApiCity: apiCitySchema,
  ApiRoutingDefaults: apiRoutingDefaultsSchema,
  ApiNetwork: apiNetworkSchema,
  ApiNetworkList: apiNetworkListSchema,
  ApiStopNode: apiStopNodeSchema,
  ApiStopEdge: apiStopEdgeSchema,
  ApiStopGraph: apiStopGraphSchema,
  ApiRideLeg: apiRideLegSchema,
  ApiTransferLeg: apiTransferLegSchema,
  ApiRouteLeg: apiRouteLegSchema,
  ApiRoutePlan: apiRoutePlanSchema,
  ApiTravelTimeEntry: apiTravelTimeEntrySchema,
  ApiTravelTimes: apiTravelTimesSchema,
  ApiNearestStation: apiNearestStationSchema,
  ApiNearestStations: apiNearestStationsSchema,
  ApiHealth: apiHealthSchema,
  ApiError: apiErrorSchema
};
export {
  apiCitySchema,
  apiCrsSchema,
  apiDirectionTypeSchema,
  apiErrorSchema,
  apiFareMatrixSchema,
  apiFareRowSchema,
  apiGeoPointSchema,
  apiHealthSchema,
  apiLineListSchema,
  apiLineModeSchema,
  apiLineSchema,
  apiLineStatusSchema,
  apiNamesSchema,
  apiNearestStationSchema,
  apiNearestStationsSchema,
  apiNetworkListSchema,
  apiNetworkSchema,
  apiPatternListSchema,
  apiPatternSchema,
  apiRideLegSchema,
  apiRouteLegSchema,
  apiRoutePlanSchema,
  apiRoutingDefaultsSchema,
  apiSchemas,
  apiSchematicPointSchema,
  apiSegmentDirectionSchema,
  apiSegmentListSchema,
  apiSegmentSchema,
  apiStationDetailSchema,
  apiStationListSchema,
  apiStationSchema,
  apiStationStatusSchema,
  apiStopEdgeSchema,
  apiStopGraphSchema,
  apiStopListSchema,
  apiStopNodeSchema,
  apiStopSchema,
  apiTimetableListSchema,
  apiTimetableSchema,
  apiTimetableStatusSchema,
  apiTransferLegSchema,
  apiTransferListSchema,
  apiTransferSchema,
  apiTravelTimeEntrySchema,
  apiTravelTimeSourceSchema,
  apiTravelTimesSchema
};
