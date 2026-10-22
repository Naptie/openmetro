/**
 * Official first/last-train handling for cn-shenyang.
 *
 * The operator publishes its per-station first/last trains in
 * `getHomePageInitData.stationsList` — one row per station, per service
 * direction, with the times of the **first and last departure at that
 * station in that direction**.
 *
 * The feed's direction codes are not "forward/backward" but per-service:
 *
 * - `tag_dir=01` — toward the **first** station of the line order. The row of
 *   that terminus carries no times (nothing departs further), so the direction
 *   is read as "descending" in the official order.
 * - `tag_dir=02` — toward the **last** station of the line order, read as
 *   "ascending".
 * - `tag_dir=03` — a **separate service** that runs on part of the line only:
 *   3号线's 东延线 (方家栏↔甘官, opened 2024-12-30). It has its own `Seq_id`
 *   numbering (1…18) and its own pattern, so it becomes a secondary pattern on
 *   Line 3 rather than a third direction of the primary one.
 *
 * The direction is therefore resolved from the data instead of assumed: the
 * terminal of a service direction is the group endpoint whose published
 * first-departure times are **not** rising along the group's own sequence —
 * that is the end the service runs away from.
 *
 * The semantics were cross-checked against the Baidu planner, whose
 * `vehicle_info.detail.first_time` / `last_time` are the boarding station's own
 * departures: 中央大街→双马 returns 05:32/23:02, which is exactly the
 * official `中央大街` row of direction `02`; 双马→十三号街 returns 05:30/23:00,
 * the official `双马` row of direction `01`.
 */
import type { TimetableEncoded } from '@openmetro/core';
import type { SymTimetableRow } from './fetch.js';

export interface DirectionInput {
  /** Canonical line id. */
  lineId: string;
  /** The line's stop ids in official order. */
  lineStopIds: string[];
  /** Official per-line station id → canonical stop id on this line. */
  stopIdByStationId: Map<string, string>;
  /** Canonical stop id → canonical station id. */
  stationIdByStopId: Map<string, string>;
  /** Canonical station id → Chinese station name. */
  nameByStationId: Map<string, string>;
  /** The operator's rows for this line. */
  rows: SymTimetableRow[];
}

export interface DirectionEntry {
  stopId: string;
  stationId: string;
  name: string;
  row: SymTimetableRow;
}

export interface ResolvedDirection {
  /** The operator's direction code (`01`, `02`, `03`). */
  dir: string;
  /** Entries in the direction's own `Seq_id` order. */
  entries: DirectionEntry[];
  /** The stop this service runs toward. */
  destinationStopId: string;
  destinationName: string;
  /** Stop ids in travel order (the destination is last). */
  travelStopIds: string[];
  /** True when the direction covers every stop of the line. */
  coversWholeLine: boolean;
}

/** Parse `HH:MM` into minutes; returns undefined for anything unparsable. */
function hhmmToMinutes(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return undefined;
  return h * 60 + min;
}

/** True when the row carries both a first and a last departure. */
export function rowHasTimes(row: SymTimetableRow): boolean {
  return (
    hhmmToMinutes(row.Plan_First_Deptr_Tm) !== undefined &&
    hhmmToMinutes(row.Plan_Last_Deptr_Tm) !== undefined
  );
}

/**
 * Resolve the service directions of one line.
 *
 * Every direction is one group of rows; the group's terminal is read from the
 * data, and a group that does not cover the whole line becomes a service of
 * its own (a secondary pattern).
 */
export function resolveDirections(input: DirectionInput): ResolvedDirection[] {
  const byDir = new Map<string, SymTimetableRow[]>();
  for (const row of input.rows) {
    if (!byDir.has(row.tag_dir)) byDir.set(row.tag_dir, []);
    byDir.get(row.tag_dir)!.push(row);
  }

  const out: ResolvedDirection[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const rows = [...byDir.get(dir)!].sort((a, b) => Number(a.Seq_id) - Number(b.Seq_id));

    const entries: DirectionEntry[] = [];
    for (const row of rows) {
      const stopId = input.stopIdByStationId.get(row.Station_ID);
      if (!stopId) continue;
      const stationId = input.stationIdByStopId.get(stopId) ?? '';
      entries.push({
        stopId,
        stationId,
        name: input.nameByStationId.get(stationId) ?? row.stat_station_nme,
        row
      });
    }
    if (entries.length < 2) continue;

    // The terminal is the group endpoint the service runs away from: the
    // published first-departure times rise along the group towards that end.
    const timed = entries.filter((e) => hhmmToMinutes(e.row.Plan_First_Deptr_Tm) !== undefined);
    const firstTime = timed.length ? hhmmToMinutes(timed[0]!.row.Plan_First_Deptr_Tm) : undefined;
    const lastTime = timed.length
      ? hhmmToMinutes(timed[timed.length - 1]!.row.Plan_First_Deptr_Tm)
      : undefined;
    const ascending = firstTime !== undefined && lastTime !== undefined && lastTime >= firstTime;

    const destination = ascending ? entries[entries.length - 1]! : entries[0]!;
    const travelStopIds = ascending
      ? entries.map((e) => e.stopId)
      : [...entries].reverse().map((e) => e.stopId);

    const covered = new Set(entries.map((e) => e.stopId));
    const coversWholeLine =
      covered.size === input.lineStopIds.length && input.lineStopIds.every((id) => covered.has(id));

    out.push({
      dir,
      entries,
      destinationStopId: destination.stopId,
      destinationName: destination.name,
      travelStopIds,
      coversWholeLine
    });
  }
  return out;
}

/**
 * Build the canonical timetable records of one direction.
 *
 * Rows without both times are skipped: the operator publishes an empty row for
 * the terminal of each direction (nothing departs further that way), and 3号线's
 * 东延线 terminal publishes a first departure without a last one.
 */
export function buildDirectionTimetables(
  direction: ResolvedDirection,
  ctx: {
    lineId: string;
    patternId: string;
    /** Canonical station id → official per-line station code. */
    stationCodeByStationId: Map<string, string>;
    /** Canonical stop id → canonical station id. */
    stationIdByStopId: Map<string, string>;
    sourceId: string;
  }
): TimetableEncoded[] {
  const out: TimetableEncoded[] = [];
  for (const entry of direction.entries) {
    const row = entry.row;
    if (!rowHasTimes(row)) continue;
    const first = row.Plan_First_Deptr_Tm!.trim();
    const last = row.Plan_Last_Deptr_Tm!.trim();
    if (!first || !last) continue;
    const stationId = ctx.stationIdByStopId.get(entry.stopId) ?? entry.stationId;
    out.push({
      id: `${ctx.lineId}-${entry.stopId}-to-${direction.destinationStopId}`,
      station_id: stationId,
      stop_id: entry.stopId,
      line_id: ctx.lineId,
      station_code: ctx.stationCodeByStationId.get(stationId),
      source_id: ctx.sourceId,
      destination_stop_id: direction.destinationStopId,
      pattern_id: ctx.patternId,
      direction_type: 'linear',
      direction_label: `${direction.destinationName}方向`,
      first_train: [first],
      last_train: [last],
      extras: {
        service: direction.coversWholeLine ? 'primary' : 'short_turn',
        direction: direction.dir,
        destination_name: direction.destinationName,
        source_note:
          '逐站首末班取自沈阳地铁官网 cocc-website 接口 getHomePageInitData.stationsList（该站该方向的首/末发车时刻）；官网对外的首末班车时刻表页面为内网 iframe，未做 OCR。'
      }
    });
  }
  return out;
}
