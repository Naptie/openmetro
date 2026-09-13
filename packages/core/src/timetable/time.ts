/**
 * Parse an "HH:MM" clock time into minutes since midnight. Returns null for
 * invalid input. Times past midnight (e.g. "24:10") are allowed and treated as
 * minutes beyond midnight so that late-night last-train chains remain
 * monotonically increasing.
 */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 48 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Format minutes since midnight back to "HH:MM", allowing hours >= 24 for
 * past-midnight times.
 */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Convert a per-day array of "HH:MM" times to a minutes array (null for gaps). */
export function toMinutesArray(times: readonly string[]): (number | null)[] {
  return times.map((t) => parseHHMM(t));
}

/**
 * Effective "HH:MM" minutes value for a given weekday index (0=Mon..6=Sun).
 * A single-element array applies to all days; a 7-element array is indexed by
 * weekday. Returns null when the array is neither length 1 nor 7.
 */
export function effectiveTime(times: readonly string[], weekdayIndex: number): number | null {
  if (times.length === 1) return parseHHMM(times[0]);
  if (times.length === 7) return parseHHMM(times[weekdayIndex] ?? '');
  return null;
}

/** Sunday-index convention: 0=Sun..6=Sat (JS Date.getDay). Convert to Mon-based. */
export function weekdayToMonBased(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** Minutes in a day. */
const DAY_MINUTES = 24 * 60;

/**
 * Normalize a timetable record's times to the canonical form:
 *
 *   - **Zero-padded `HH:MM`** (a source may write `6:00`).
 *   - **Service-day convention**: minutes since the service day's midnight, so
 *     an after-midnight train is written `24:xx` / `25:xx` (GTFS style), never
 *     `00:xx` / `01:xx`. A source's `00:xx` last train is numerically earlier
 *     than `first_train`, so it is shifted by +24h. Already-`24:xx`+ times are
 *     left as-is, making the function idempotent.
 *
 * `first_train` is the service-day anchor and is never shifted (only padded).
 */
export function normalizeTimetableTimes<
  T extends { first_train: readonly string[]; last_train: readonly string[] }
>(record: T): T {
  const first = record.first_train;
  const last = record.last_train;
  if (first.length === 0 || last.length === 0) return record;

  let changed = false;
  // Sources sometimes use a full-width colon (`7：01`).
  const clean = (time: string) => time.replace('：', ':').trim();
  const pad = (raw: string): string => {
    const time = clean(raw);
    const minutes = parseHHMM(time);
    if (minutes == null) return raw;
    const formatted = formatMinutes(minutes);
    if (formatted !== raw) changed = true;
    return formatted;
  };

  const firstTrain = first.map(pad);
  const lastTrain = last.map((raw, i) => {
    const time = clean(raw);
    const reference = first.length === 1 ? first[0] : (first[i] ?? first[0]);
    const firstMinutes = parseHHMM(clean(reference));
    const lastMinutes = parseHHMM(time);
    if (firstMinutes == null || lastMinutes == null) return raw;
    const adjusted = lastMinutes < firstMinutes ? lastMinutes + DAY_MINUTES : lastMinutes;
    const formatted = formatMinutes(adjusted);
    if (formatted !== raw) changed = true;
    return formatted;
  });

  return changed ? ({ ...record, first_train: firstTrain, last_train: lastTrain } as T) : record;
}

/** True when a record has at least one parseable first and last train time. */
export function hasValidTimes(record: {
  first_train: readonly string[];
  last_train: readonly string[];
}): boolean {
  const valid = (times: readonly string[]) =>
    times.some((t) => parseHHMM(t.replace('：', ':').trim()) != null);
  return valid(record.first_train) && valid(record.last_train);
}
