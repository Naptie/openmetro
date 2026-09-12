import { Effect, Schema } from "effect";
import {
  DataFile,
  FareMatrix,
  type FareMatrixEncoded,
  Line,
  Network,
  type NetworkEncoded,
  Pattern,
  Segment,
  Station,
  Stop,
  Timetable,
  Transfer,
} from "../schema/index.js";
import type { NetworkData, RawNetworkFiles } from "./types.js";

const LineFile = DataFile(Line);
const StationFile = DataFile(Station);
const StopFile = DataFile(Stop);
const PatternFile = DataFile(Pattern);
const SegmentFile = DataFile(Segment);
const TransferFile = DataFile(Transfer);
const TimetableFile = DataFile(Timetable);

interface RecordsWrapper {
  records: unknown[];
}

/** Decode a wrapped canonical file into its (encoded) records. */
function decodeRecords(schema: Schema.Schema<any>, raw: unknown): unknown[] {
  const wrapped = Schema.encodeSync(schema as Schema.Schema<unknown>)(
    Schema.decodeUnknownSync(schema as Schema.Schema<unknown>)(raw),
  ) as RecordsWrapper;
  return [...wrapped.records];
}

/** Decode and validate `network.json` (metadata only). */
export function decodeNetworkMeta(raw: unknown): Effect.Effect<NetworkEncoded, unknown> {
  return Schema.decodeUnknown(Network)(raw).pipe(
    Effect.map((w) => Schema.encodeSync(Network)(w) as NetworkEncoded),
  );
}

/** Decode and validate `fares.json` (a bare matrix document). */
export function decodeFareMatrix(raw: unknown): Effect.Effect<FareMatrixEncoded, unknown> {
  return Schema.decodeUnknown(FareMatrix)(raw).pipe(
    Effect.map((w) => Schema.encodeSync(FareMatrix)(w) as FareMatrixEncoded),
  );
}

/** Decode and validate a full network's canonical files. */
export function decodeNetworkData(raw: RawNetworkFiles): Effect.Effect<NetworkData, unknown> {
  const records = (schema: Schema.Schema<any>, value: unknown) =>
    Effect.try(() => decodeRecords(schema, value));
  const optional = (schema: Schema.Schema<any>, value: unknown) =>
    value == null ? Effect.succeed([]) : records(schema, value);

  return Effect.all(
    {
      network: decodeNetworkMeta(raw.network),
      lines: records(LineFile, raw.lines),
      stations: records(StationFile, raw.stations),
      stops: records(StopFile, raw.stops),
      patterns: optional(PatternFile, raw.patterns),
      segments: records(SegmentFile, raw.segments),
      transfers: records(TransferFile, raw.transfers),
      timetables: optional(TimetableFile, raw.timetables),
      fares: raw.fares == null ? Effect.succeed(undefined) : decodeFareMatrix(raw.fares),
    },
    { concurrency: "unbounded" },
  ) as Effect.Effect<NetworkData, unknown>;
}
