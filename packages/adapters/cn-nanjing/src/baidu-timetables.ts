/**
 * Baidu Direction Lite timetable harvest — city-agnostic implementation lives
 * in `@openmetro/core` (`gapfill/timetables.ts`). This module re-exports it so
 * the adapter can keep a stable local import path.
 */
// Historical local name: BD-09 → GCJ-02 taking (lat, lng) like the old copy.
// Re-export time helpers used alongside the harvest (SSOT: timetable/time.ts).
export {
  type BaiduHarvestOptions,
  type BaiduLegTimes,
  type BaiduStationRef,
  bd09ToGcj02LatLng,
  bd09ToGcj02LatLng as bd09ToGcj02,
  fetchBaiduSubwayLeg,
  formatMinutes,
  gcj02ToBd09,
  geocodeBaiduPlace,
  type HarvestedStationDir,
  harvestBaiduTimetables,
  lastDepartureFromArrival,
  loadBaiduAk,
  parseHHMM as parseHm
} from '@openmetro/core';
