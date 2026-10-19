import { createHash } from 'node:crypto';
import {
  decodeFeed,
  type FareMatrixEncoded,
  fetchFeed,
  fetchFeedText,
  parseCsv
} from '@openmetro/core';

type SourceEncoded = FareMatrixEncoded['source'][number];

const DATASET_URL = 'https://data.taipei/dataset/detail?id=c30ca421-d935-4faa-b523-9c175c8de738';
const GENERAL_HOLIDAYS = new Set(['放假之紀念日及節日', '補假', '調整放假日']);

export interface TaiwanServiceCalendar {
  valid_from: string;
  valid_to: string;
  holiday_dates: string[];
}

/** The official CSV lists exceptions and weekends, not every working weekday. */
export function parseTaiwanServiceCalendar(csv: string, year: number): TaiwanServiceCalendar {
  const dates = new Set<string>();
  const holidays: string[] = [];
  for (const row of parseCsv(csv)) {
    const raw = row.Date?.trim();
    if (!raw || !/^\d{8}$/.test(raw)) throw new Error(`Taiwan calendar: invalid Date ${raw}`);
    if (raw.slice(0, 4) !== String(year)) continue;
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const day = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date)
      throw new Error(`Taiwan calendar: invalid Date ${raw}`);
    if (dates.has(date)) throw new Error(`Taiwan calendar: duplicate Date ${date}`);
    dates.add(date);

    const isHoliday = row.isHoliday?.trim();
    if (isHoliday !== '是' && isHoliday !== '否')
      throw new Error(`Taiwan calendar: unknown isHoliday ${isHoliday} on ${date}`);
    // Weekend service is already selected by weekly rules, even on government
    // make-up workdays. This lookup only adds general weekday holidays.
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6 || isHoliday === '否') continue;
    const category = row.holidayCategory?.trim();
    // Police/military and other profession-specific days are not general holidays.
    if (category === '特定節日') continue;
    if (!category || !GENERAL_HOLIDAYS.has(category))
      throw new Error(`Taiwan calendar: unknown holiday category ${category} on ${date}`);
    holidays.push(date);
  }
  if (dates.size === 0) throw new Error(`Taiwan calendar: no rows for ${year}`);

  // A stale or truncated year must not silently become a mostly weekday calendar.
  // Include rows marked 否: a weekend make-up workday is still a required source row.
  for (
    const day = new Date(Date.UTC(year, 0, 1));
    day.getUTCFullYear() === year;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) continue;
    const date = day.toISOString().slice(0, 10);
    if (!dates.has(date)) throw new Error(`Taiwan calendar: missing weekend row ${date}`);
  }
  return {
    valid_from: `${year}-01-01`,
    valid_to: `${year}-12-31`,
    holiday_dates: holidays.sort()
  };
}

export async function fetchTaiwanServiceCalendar(): Promise<{
  calendar: TaiwanServiceCalendar;
  source: SourceEncoded;
}> {
  const page = await fetchFeedText(DATASET_URL);
  const url = page.match(
    /https:\/\/data\.taipei\/api\/frontstage\/tpeod\/dataset\/resource\.download\?rid=[a-f0-9-]+/
  )?.[0];
  if (!url) throw new Error('Taiwan calendar: official download link missing');
  const bytes = await fetchFeed(url);
  const retrievedAt = new Date();
  const year = Number(
    new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(retrievedAt)
  );
  const csv = decodeFeed(bytes);
  const calendar = parseTaiwanServiceCalendar(csv, year);
  const publishedYears = new Set(parseCsv(csv).map((row) => Number(row.Date?.slice(0, 4))));
  // Keep the previous overnight service day and the next weekly sync across New Year.
  for (const adjacentYear of [year - 1, year + 1]) {
    if (!publishedYears.has(adjacentYear)) continue;
    let adjacent: TaiwanServiceCalendar;
    try {
      adjacent = parseTaiwanServiceCalendar(csv, adjacentYear);
    } catch (error) {
      console.warn(`Taiwan calendar: ignoring incomplete adjacent year ${adjacentYear}: ${error}`);
      continue;
    }
    calendar.valid_from = [calendar.valid_from, adjacent.valid_from].sort()[0]!;
    calendar.valid_to = [calendar.valid_to, adjacent.valid_to].sort().at(-1)!;
    calendar.holiday_dates.push(...adjacent.holiday_dates);
  }
  calendar.holiday_dates.sort();
  return {
    calendar,
    source: {
      name: 'taiwan-service-calendar',
      url,
      version: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      retrieved_at: retrievedAt.toISOString(),
      license: 'custom',
      license_url: 'https://data.taipei/rule',
      attribution: '臺北市政府人事處 / 臺北市資料大平臺',
      notes: JSON.stringify({
        dataset_url: DATASET_URL,
        valid_from: calendar.valid_from,
        valid_to: calendar.valid_to,
        scope:
          'Government calendar general weekday holidays only; 特定節日 excluded. ' +
          'Weekend make-up workdays retain weekly weekend service. ' +
          'Special operating-date announcements remain subject to the operator.'
      })
    }
  };
}
