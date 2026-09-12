import type { StopEncoded, TimetableEncoded } from "@openmetro/core";

export interface BjTimeInfoStation {
  stationName: string;
  lineCode: string;
  upFirstTime?: string | null;
  upLastTime?: string | null;
  downFirstTime?: string | null;
  downLastTime?: string | null;
  upDestName?: string | null;
  downDestName?: string | null;
}

export interface BjTimeInfosData {
  lineCode: string;
  flTimes: BjTimeInfoStation[];
}

export interface BjTimeInfosResponse {
  data?: BjTimeInfosData[];
}

export interface BuildTimeInfosOpts {
  timeinfos: BjTimeInfosResponse;
  /** Map from line code (e.g. "04") to canonical line_id. */
  lineIdByCode: Map<string, string>;
  /** Resolve a (possibly uncleaned) station name to a canonical station id. */
  stationIdByName: (name: string) => string | undefined;
  /** Ordered stops by line_id. */
  stopsByLine: Map<string, StopEncoded[]>;
  /** Resolve a canonical station id from a cleaned terminal name. */
  stationIdByCleanedName: (cleanedName: string) => string | undefined;
  /** Set of line_ids that are loop lines (from XML loop attribute). */
  loopLineIds: Set<string>;
  networkId: string;
}

function isReal(v: string | null | undefined): v is string {
  return !!v && v !== "——" && v !== "--";
}

/** Strip parenthetical / full-width annotations for name matching. */
function cleanName(name: string): string {
  return name.replace(/[（）()]/g, "").trim();
}

/** Detect loop direction type from a Beijing direction label. */
function detectLoopDirection(
  label: string | null | undefined,
): "loop_inner" | "loop_outer" | undefined {
  if (!label) return undefined;
  if (label.includes("内") || label.includes("(内)")) return "loop_inner";
  if (label.includes("外") || label.includes("(外)")) return "loop_outer";
  return undefined;
}

/**
 * Build canonical timetable records from the Beijing official
 * `/api/guanwang/v2/getTimeinfos` payload. For each station on a line, a record
 * is produced whenever a direction has a real first/last train time. This is
 * the authoritative source covering all Beijing lines.
 */
export function buildBeijingTimetablesFromTimeinfos(opts: BuildTimeInfosOpts): TimetableEncoded[] {
  const {
    timeinfos,
    lineIdByCode,
    stationIdByName,
    stopsByLine,
    stationIdByCleanedName,
    loopLineIds,
    networkId,
  } = opts;
  const lines = timeinfos.data ?? [];
  const out: TimetableEncoded[] = [];

  for (const line of lines) {
    const lineId = lineIdByCode.get(line.lineCode);
    if (!lineId) continue;
    const lineStops = stopsByLine.get(lineId) ?? [];
    const isLoop = loopLineIds.has(lineId);

    for (const st of line.flTimes ?? []) {
      const stationId = stationIdByName(st.stationName);
      if (!stationId) continue;
      const stop = lineStops.find((s) => s.station_id === stationId);
      if (!stop) continue;
      // Beijing lines each have a single primary pattern.
      const patternId = `${lineId}-pattern-main`;

      const upDest = st.upDestName ? cleanName(st.upDestName) : "";
      const downDest = st.downDestName ? cleanName(st.downDestName) : "";
      const upTermId = upDest ? stationIdByCleanedName(upDest) : undefined;
      const downTermId = downDest ? stationIdByCleanedName(downDest) : undefined;

      // Detect loop direction from label (e.g. "内环" or "外环").
      const upDirType = isLoop ? detectLoopDirection(st.upDestName) : undefined;
      const downDirType = isLoop ? detectLoopDirection(st.downDestName) : undefined;

      if (isReal(st.upFirstTime) && isReal(st.upLastTime)) {
        const upStop = lineStops.find((s) => s.station_id === upTermId);
        const destination = upStop?.id ?? lineStops[lineStops.length - 1]?.id;
        if (destination) {
          out.push({
            id: `${networkId}-${lineId}-${stationId}-up-${slugOfTab(upDest)}`,
            station_id: stationId,
            stop_id: stop.id,
            line_id: lineId,
            station_code: (st as { stationCode?: string }).stationCode,
            source_id: (st as { stationCode?: string }).stationCode,
            destination_stop_id: upDirType ? undefined : destination,
            pattern_id: patternId,
            direction_type: upDirType ?? "linear",
            direction_label: st.upDestName ?? undefined,
            first_train: [st.upFirstTime],
            last_train: [st.upLastTime],
            service: "all_days",
          });
        }
      }
      if (isReal(st.downFirstTime) && isReal(st.downLastTime)) {
        const downStop = lineStops.find((s) => s.station_id === downTermId);
        const destination = downStop?.id ?? lineStops[0]?.id;
        if (destination) {
          out.push({
            id: `${networkId}-${lineId}-${stationId}-down-${slugOfTab(downDest)}`,
            station_id: stationId,
            stop_id: stop.id,
            line_id: lineId,
            station_code: (st as { stationCode?: string }).stationCode,
            source_id: (st as { stationCode?: string }).stationCode,
            destination_stop_id: downDirType ? undefined : destination,
            pattern_id: patternId,
            direction_type: downDirType ?? "linear",
            direction_label: st.downDestName ?? undefined,
            first_train: [st.downFirstTime],
            last_train: [st.downLastTime],
            service: "all_days",
          });
        }
      }
    }
  }
  return out;
}

/** Compact readable slug for a destination name (ASCII-safe). */
function slugOfTab(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "dest"
  );
}
