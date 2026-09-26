/**
 * Baidu Direction Lite timetable harvest — city-agnostic implementation lives
 * in `@openmetro/core` (`gapfill/timetables.ts`). This module re-exports it so
 * the adapter can keep a stable local import path.
 */
// Re-export time helpers used alongside the harvest (SSOT: timetable/time.ts).
/** GCJ-02 → BD-09 (SSOT: geocode/coords.ts). */
export {
  type BaiduHarvestOptions,
  type BaiduLegTimes,
  type BaiduStationRef,
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
