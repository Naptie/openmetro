/**
 * Official first/last-train handling for cn-changsha.
 *
 * The operator publishes each station's first and last departure **per
 * service direction** inside the CMS feed's `times` field:
 *
 * ```
 * #1号线（金盆丘—尚双塘）首车：6:30 末车：23:00
 * #3号线（月湖公园北—广生）首车：6:30 末车：23:56
 * #3号线（月湖公园北—红桥）首车：6:33 末车：23:16
 * #3号线（月湖公园北—湘潭北）首车：6:33 末车：21:04
 * #磁浮快线（往机场方向）首车：7:00 末车：22:10。（工作日（不含节假日前一天））
 * ```
 *
 * Three conventions the parser has to honour:
 *
 * 1. **The label is `origin—destination`, not a direction axis.** On the metro
 *    lines the first component is the station the row belongs to and the second
 *    is the terminus the service runs toward. The maglev has no origin
 *    component: it publishes `往<terminus>方向` instead.
 * 2. **Line 3 has three destinations, not two.** 3号线 runs to 广生 in the
 *    east and splits west of 山塘 into the 湘潭北 branch and the 红桥
 *    short-turn, so the same station publishes up to three `times` rows. The
 *    direction is therefore carried by `destination_stop_id`, never by a
 *    forward/backward axis — the repository's model for a branched line.
 * 3. **The maglev publishes two calendar variants.** Its rows carry a calendar
 *    note (`工作日（不含节假日前一天）` / `双休日、节假日（含节假日前一天）`),
 *    which becomes a 7-element per-weekday array (Mon–Fri from the weekday
 *    variant, Sat–Sun from the weekend variant). The metro lines publish a
 *    single variant, which stays a 1-element array.
 */
import type { TimetableEncoded } from '@openmetro/core';

/** One published first/last row of a station's `times` field. */
export interface OfficialTimeEntry {
  /** The label's line part (`3号线`, `磁浮快线`). */
  lineLabel: string;
  /** Origin part of the label; absent for the maglev's `往…方向` rows. */
  originLabel?: string;
  /** Destination part of the label (`广生`, `红桥`, `湘潭北`). */
  destinationLabel: string;
  /** True when the label is a bare direction (`往机场方向`). */
  directionOnly: boolean;
  /** First departure. */
  first: string;
  /** Last departure. */
  last: string;
  /** Calendar note exactly as published. */
  calendar?: string;
}

/**
 * `#<line>（<label>）首车：H:MM 末车：H:MM[。<calendar>]`
 *
 * The label may itself contain brackets (3号线's `松雅湖（南）—广生`), so the
 * label group is greedy and anchored by the `）首车：` that follows it.
 */
const TIME_ROW =
  /^#([^（(]+)[（(](.+)[）)]\s*首车：\s*(\d{1,2}:\d{2})\s*末车：\s*(\d{1,2}:\d{2})\s*(.*)$/;

/** The em/en dash the operator uses between the origin and the destination. */
const DASH = /[—–−-]/;

/**
 * Split a station's `times` field into its published rows.
 *
 * Rows are separated by CRLF or by the `<br>` the CMS emits inside a cell.
 */
export function parseOfficialTimes(raw: string | undefined): OfficialTimeEntry[] {
  if (!raw?.trim()) return [];
  const chunks = raw
    .split(/<br\s*\/?>|\r\n|\r|\n/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const out: OfficialTimeEntry[] = [];
  for (const chunk of chunks) {
    const m = TIME_ROW.exec(chunk);
    if (!m) continue;
    const [, lineLabel, label, first, last, rest] = m;
    if (!lineLabel || !label || !first || !last) continue;

    let originLabel: string | undefined;
    let destinationLabel = label;
    let directionOnly = false;

    const dash = DASH.exec(label);
    if (dash) {
      originLabel = label.slice(0, dash.index).trim();
      destinationLabel = label.slice(dash.index + 1).trim();
    } else {
      // `往<terminus>方向` — the maglev's direction-only label.
      const dir = /^往(.+)方向$/.exec(label);
      if (dir) {
        directionOnly = true;
        destinationLabel = dir[1]!.trim();
      }
    }
    if (!destinationLabel) continue;

    const calendar = rest
      .replace(/^[。.]/, '')
      .trim()
      .replace(/^[（(]|[）)]$/g, '')
      .trim();
    out.push({
      lineLabel: lineLabel.trim(),
      originLabel: originLabel || undefined,
      destinationLabel,
      directionOnly,
      first: first.trim(),
      last: last.trim(),
      calendar: calendar || undefined
    });
  }
  return out;
}

/** Which published calendar variant a note describes. */
export type CalendarKind = 'weekday' | 'weekend';

export function classifyCalendar(note: string | undefined): CalendarKind | undefined {
  if (!note) return undefined;
  // `工作日` is checked first: the maglev's weekday note is
  // `工作日（不含节假日前一天）`, and its `节假日前一天` contains the
  // substring `节假日`, which would otherwise misclassify it as a weekend.
  if (note.includes('工作日')) return 'weekday';
  if (note.includes('双休日') || note.includes('节假日')) return 'weekend';
  return undefined;
}

/**
 * The per-weekday time arrays of one direction.
 *
 * A direction published with a single variant keeps a 1-element array (the
 * times are the same every day). A direction published with both a weekday
 * and a weekend variant becomes a 7-element array indexed Mon…Sun: the weekday
 * variant fills Monday–Friday, the weekend variant Saturday–Sunday.
 */
export function buildCalendarArrays(entries: OfficialTimeEntry[]): {
  first: string[];
  last: string[];
  kinds: CalendarKind[];
} {
  const kinds: CalendarKind[] = [];
  let weekday: OfficialTimeEntry | undefined;
  let weekend: OfficialTimeEntry | undefined;

  for (const entry of entries) {
    const kind = classifyCalendar(entry.calendar);
    if (kind === 'weekday') weekday = weekday ?? entry;
    else if (kind === 'weekend') weekend = weekend ?? entry;
  }

  if (!weekday && !weekend) {
    // No calendar note at all: a single published variant.
    const only = entries[0];
    if (!only) return { first: [], last: [], kinds };
    return { first: [only.first], last: [only.last], kinds };
  }
  if (weekday && !weekend) {
    kinds.push('weekday');
    return { first: [weekday.first], last: [weekday.last], kinds };
  }
  if (!weekday && weekend) {
    kinds.push('weekend');
    return { first: [weekend.first], last: [weekend.last], kinds };
  }
  kinds.push('weekday', 'weekend');
  const first = [
    weekday!.first,
    weekday!.first,
    weekday!.first,
    weekday!.first,
    weekday!.first,
    weekend!.first,
    weekend!.first
  ];
  const last = [
    weekday!.last,
    weekday!.last,
    weekday!.last,
    weekday!.last,
    weekday!.last,
    weekend!.last,
    weekend!.last
  ];
  return { first, last, kinds };
}

/** A direction of one line, resolved against the line's stops. */
export interface ResolvedDirection {
  /** Stop the service runs toward. */
  destinationStopId: string;
  /** Canonical station id of that stop. */
  destinationStationId: string;
  /** The operator's destination wording, e.g. `广生`. */
  destinationLabel: string;
  /** Stop the service starts from (the station the rows belong to). */
  originStopId: string;
  /** Human direction label, e.g. `广生方向` / `往机场方向`. */
  directionLabel: string;
  /** The published rows of this direction. */
  entries: OfficialTimeEntry[];
}

/**
 * Build the canonical timetable records of one direction.
 *
 * `destinationStopId` carries the direction — a branch publishes several
 * destinations on one alignment, so a forward/backward axis would be
 * meaningless.
 */
export function buildDirectionTimetables(
  direction: ResolvedDirection,
  ctx: {
    lineId: string;
    patternId: string;
    /** Canonical stop id → canonical station id. */
    stationIdByStopId: Map<string, string>;
    /** Canonical station id → official per-line station code. */
    stationCodeByStationId: Map<string, string>;
    sourceId: string;
  }
): TimetableEncoded[] {
  const { first, last, kinds } = buildCalendarArrays(direction.entries);
  if (first.length === 0 || last.length === 0) return [];

  const stationId = ctx.stationIdByStopId.get(direction.originStopId) ?? '';
  const record: TimetableEncoded = {
    id: `${ctx.lineId}-${direction.originStopId}-to-${direction.destinationStopId}`,
    station_id: stationId,
    stop_id: direction.originStopId,
    line_id: ctx.lineId,
    station_code: ctx.stationCodeByStationId.get(stationId),
    source_id: ctx.sourceId,
    destination_stop_id: direction.destinationStopId,
    origin_stop_id: direction.originStopId,
    pattern_id: ctx.patternId,
    direction_type: 'linear',
    direction_label: direction.directionLabel,
    first_train: first,
    last_train: last,
    extras: {
      destination_name: direction.destinationLabel,
      calendar: kinds.join('+') || 'single',
      calendar_note: direction.entries.find((e) => e.calendar)?.calendar,
      source_note:
        '逐站逐方向首末班取自长沙轨道交通集团官网 www.hncsmtr.com 的 Creator CMS 接口 findDtStationData.page（该站该方向的首/末发车时刻）；方向以终点站表示，3 号线同时发布广生、红桥、湘潭北三个终点。磁浮快线另发布工作日与双休日两套时刻。'
    }
  };
  return [record];
}
