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

/** Fully decoded canonical data for one network. */
export interface NetworkData {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /** Origin-destination fare matrix; absent when the network has no fares. */
  fares: FareMatrixEncoded | undefined;
}

/**
 * Raw (un-decoded) canonical file payloads for one network. Optional files may
 * be omitted; the decoder treats them as empty.
 */
export interface RawNetworkFiles {
  network: unknown;
  lines: unknown;
  stations: unknown;
  stops: unknown;
  patterns?: unknown;
  segments: unknown;
  transfers: unknown;
  timetables?: unknown;
  fares?: unknown;
}
