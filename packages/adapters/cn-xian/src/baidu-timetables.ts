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
  fetchBaiduSubwayLeg,
  geocodeBaiduPlace,
  harvestBaiduTimetables,
  lastDepartureFromArrival,
  loadBaiduAk
} from '@openmetro/core';

// Re-export time helpers used alongside the harvest (SSOT: timetable/time.ts).
export { formatMinutes, parseHHMM as parseHm } from '@openmetro/core';

/** GCJ-02 → BD-09 (SSOT: geocode/coords.ts). */
export { gcj02ToBd09 } from '@openmetro/core';
