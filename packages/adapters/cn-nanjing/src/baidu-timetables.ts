/**
 * Baidu Direction Lite timetable harvest — city-agnostic implementation lives
 * in `@openmetro/core` (`gapfill/timetables.ts`). This module re-exports it so
 * the adapter can keep a stable local import path.
 */
export {
  type BaiduHarvestOptions,
  type BaiduLegTimes,
  type BaiduStationRef,
  type HarvestedStationDir,
  bd09ToGcj02LatLng,
  fetchBaiduSubwayLeg,
  gcj02ToBd09,
  geocodeBaiduPlace,
  harvestBaiduTimetables,
  lastDepartureFromArrival,
  loadBaiduAk
} from '@openmetro/core';

// Historical local name: BD-09 → GCJ-02 taking (lat, lng) like the old copy.
export { bd09ToGcj02LatLng as bd09ToGcj02 } from '@openmetro/core';

// Re-export time helpers used alongside the harvest (SSOT: timetable/time.ts).
export { formatMinutes, parseHHMM as parseHm } from '@openmetro/core';
