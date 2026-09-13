import type { Schema } from 'effect';
import type {
  FareMatrix,
  Line,
  Network,
  Pattern,
  Segment,
  Station,
  Stop,
  Timetable,
  Transfer
} from './index.js';

export * from './city.js';
export * from './fare.js';
export * from './file.js';
export * from './geometry.js';
export * from './line.js';
export * from './names.js';
export * from './network.js';
export * from './pattern.js';
export * from './provenance.js';
export * from './segment.js';
export * from './station.js';
export * from './stop.js';
export * from './timetable.js';
export * from './transfer.js';

// Encoded (serialization) types: optional fields are plain `T | undefined`,
// not Effect `Option<T>`. Use these when constructing canonical JSON.
export type LineEncoded = Schema.Schema.Encoded<typeof Line>;
export type StationEncoded = Schema.Schema.Encoded<typeof Station>;
export type StopEncoded = Schema.Schema.Encoded<typeof Stop>;
export type PatternEncoded = Schema.Schema.Encoded<typeof Pattern>;
export type SegmentEncoded = Schema.Schema.Encoded<typeof Segment>;
export type FareMatrixEncoded = Schema.Schema.Encoded<typeof FareMatrix>;
export type TransferEncoded = Schema.Schema.Encoded<typeof Transfer>;
export type TimetableEncoded = Schema.Schema.Encoded<typeof Timetable>;
export type NetworkEncoded = Schema.Schema.Encoded<typeof Network>;
