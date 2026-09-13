import type { StationEncoded, StopEncoded, TransferEncoded } from '../schema/index.js';

/**
 * An officially published transfer time (e.g. Beijing's `interchange.xml`).
 * Keyed by station + ordered line pair; anything not covered falls back to the
 * network's `routing.default_transfer_seconds`.
 */
export interface OfficialTransfer {
  station_id: string;
  from_line_id: string;
  to_line_id: string;
  walk_time_seconds?: number;
  is_out_of_station?: boolean;
  source_id?: string;
}

function key(stationId: string, fromLineId: string, toLineId: string): string {
  return `${stationId}|${fromLineId}|${toLineId}`;
}

/**
 * Derive the canonical transfer edge set for a network.
 *
 * A transfer exists for every ordered pair of distinct lines that call at the
 * same station. This is the single derivation used by every adapter (and the
 * one-off data migration), so the transfer table can never drift from the
 * stop/line topology. Official walk times override the derived default when
 * available; otherwise `walk_time_seconds` is omitted and consumers apply
 * `network.routing.default_transfer_seconds`.
 */
export function deriveTransfers(
  stations: Pick<StationEncoded, 'id'>[],
  stops: Pick<StopEncoded, 'id' | 'station_id' | 'line_id'>[],
  official: OfficialTransfer[] = []
): TransferEncoded[] {
  const stationIds = new Set(stations.map((s) => s.id));
  const linesByStation = new Map<string, Map<string, string>>();
  for (const stop of stops) {
    if (!stationIds.has(stop.station_id)) continue;
    const lines = linesByStation.get(stop.station_id) ?? new Map<string, string>();
    if (!lines.has(stop.line_id)) lines.set(stop.line_id, stop.id);
    linesByStation.set(stop.station_id, lines);
  }

  const officialByKey = new Map<string, OfficialTransfer>();
  for (const o of official) {
    officialByKey.set(key(o.station_id, o.from_line_id, o.to_line_id), o);
  }

  const out: TransferEncoded[] = [];
  for (const [stationId, lines] of linesByStation) {
    const entries = [...lines.entries()];
    if (entries.length < 2) continue;
    for (const [fromLineId, fromStopId] of entries) {
      for (const [toLineId, toStopId] of entries) {
        if (fromLineId === toLineId) continue;
        const match = officialByKey.get(key(stationId, fromLineId, toLineId));
        out.push({
          id: `xfer-${fromStopId}-${toStopId}`,
          station_id: stationId,
          from_line_id: fromLineId,
          to_line_id: toLineId,
          from_stop_id: fromStopId,
          to_stop_id: toStopId,
          walk_time_seconds: match?.walk_time_seconds,
          is_out_of_station: match?.is_out_of_station,
          source_id: match?.source_id
        });
      }
    }
  }
  return out;
}
