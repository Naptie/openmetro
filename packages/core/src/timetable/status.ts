import type { TimetableEncoded } from '../schema/index.js';
import { effectiveTime, weekdayToMonBased } from './time.js';

export interface InServiceStatus {
  timetable_id: string;
  station_id: string;
  line_id: string;
  destination_stop_id?: string;
  is_in_service: boolean;
  first_train: string;
  last_train: string;
  /** IANA timezone the status was evaluated in (from `network.timezone`). */
  timezone: string;
  /** Current local time in `timezone`, as `HH:MM`. */
  now: string; // HH:MM used for the check
}

const JS_DAY_BY_WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

interface LocalTime {
  /** Minutes since local midnight. */
  minutes: number;
  /** 0=Mon .. 6=Sun. */
  weekdayIndex: number;
  /** Local time as `HH:MM`. */
  hhmm: string;
}

function partsFor(date: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(date);
}

/**
 * Resolve the wall-clock time and weekday in a network's IANA timezone.
 *
 * Workers (and any runtime) may be in UTC or an unrelated local zone, so the
 * city timezone recorded in `network.json` must be used explicitly. Falls back
 * to UTC if the timezone is unknown/invalid.
 */
export function localTimeParts(now: Date, timeZone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = partsFor(now, timeZone);
  } catch {
    parts = partsFor(now, 'UTC');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const jsDay = JS_DAY_BY_WEEKDAY[get('weekday')] ?? now.getUTCDay();
  return {
    minutes: hour * 60 + minute,
    weekdayIndex: weekdayToMonBased(jsDay),
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

/** Is `minutes` inside [first, last] for one service day? `last` may be >1440. */
function inServiceWindow(record: TimetableEncoded, minutes: number, weekdayIndex: number): boolean {
  const first = effectiveTime(record.first_train, weekdayIndex);
  const last = effectiveTime(record.last_train, weekdayIndex);
  if (first == null || last == null) return false;
  return minutes >= first && minutes <= last;
}

/**
 * Compute whether a timetable record is in service at a local wall-clock time.
 *
 * Canonical last-train times use the service-day convention (`24:xx`/`25:xx`
 * for after midnight), so a clock time after midnight may belong to the
 * **previous** service day's tail. Both windows are checked: the current
 * weekday's window at `nowMinutes`, and the previous weekday's window at
 * `nowMinutes + 1440`.
 */
export function isInService(
  record: TimetableEncoded,
  nowMinutes: number,
  weekdayIndex: number // 0=Mon..6=Sun
): boolean {
  if (inServiceWindow(record, nowMinutes, weekdayIndex)) return true;
  const previousWeekday = (weekdayIndex + 6) % 7;
  return inServiceWindow(record, nowMinutes + 24 * 60, previousWeekday);
}

/** Convenience: build an in-service status for a record from a Date. */
export function statusForRecord(
  record: TimetableEncoded,
  now: Date = new Date(),
  timeZone = 'UTC'
): InServiceStatus {
  const { minutes, weekdayIndex, hhmm } = localTimeParts(now, timeZone);
  const isIn = isInService(record, minutes, weekdayIndex);
  const first = effectiveTime(record.first_train, weekdayIndex);
  const last = effectiveTime(record.last_train, weekdayIndex);
  const fmt = (m: number | null) => {
    if (m == null) return '';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  return {
    timetable_id: record.id,
    station_id: record.station_id,
    line_id: record.line_id,
    destination_stop_id: record.destination_stop_id,
    is_in_service: isIn,
    first_train: fmt(first),
    last_train: fmt(last),
    timezone: timeZone,
    now: hhmm
  };
}
