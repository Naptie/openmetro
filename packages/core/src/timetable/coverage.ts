import type { TimetableEncoded } from '../schema/index.js';

/** Strict coverage for a simple line/ring (not a branching service network).
 * Require exactly one departure per expected direction at each stop, with all
 * calendar cells populated. Terminal self-arrivals are not departure service.
 */
export function assertSimpleServiceCoverage(
  stopIds: readonly string[],
  loop: boolean,
  timetables: readonly TimetableEncoded[]
): void {
  const allowed = new Set(stopIds);
  if (allowed.size !== stopIds.length || stopIds.length < 2)
    throw new Error('Invalid service order');
  for (const row of timetables) {
    if (!allowed.has(row.stop_id)) throw new Error(`Unknown service stop ${row.stop_id}`);
    for (const times of [row.first_train, row.last_train]) {
      if (
        ![1, 7].includes(times.length) ||
        times.some((t) => !/^(?:[01]\d|2[0-9]):[0-5]\d$/.test(t))
      )
        throw new Error(`Invalid service times ${row.stop_id}`);
    }
  }
  for (const stop of stopIds) {
    const expected = loop
      ? ['loop_inner', 'loop_outer']
      : [stopIds[0]!, stopIds.at(-1)!].filter((id) => id !== stop);
    const rows = timetables.filter((t) => t.stop_id === stop && !t.is_arrival);
    const directions = rows.map((t) => (loop ? t.direction_type : t.destination_stop_id));
    if (
      directions.length !== expected.length ||
      expected.some((d) => directions.filter((x) => x === d).length !== 1)
    )
      throw new Error(`Missing timetable direction or duplicate service at ${stop}`);
  }
}
