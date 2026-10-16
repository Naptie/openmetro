import type { ApiStationDetail, ApiTimetable } from 'openmetro-client';

/** Use the API's network-local service day, including holiday and overnight selection. */
export function timetableTimes(
  timetable: ApiTimetable,
  status: ApiStationDetail['status'][number] | undefined
) {
  // Without a status, only a one-value daily table can be shown unambiguously.
  const dailyTime = (times: string[]) => (times.length === 1 ? times[0] : undefined);
  return {
    first: (status?.first_train ?? dailyTime(timetable.first_train)) || '—',
    last: (status?.last_train ?? dailyTime(timetable.last_train)) || '—',
    serviceDate: status?.service_date
  };
}
