/** The operator's service-time article is HTML, unlike its obsolete schedule API. */
import { cleanTime } from '@openmetro/core';

export function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TimetableRow {
  station: string;
  first: [string | null, string | null];
  last: [string | null, string | null];
}

export interface TimetableSection {
  line: string;
  calendar: 'weekday' | 'weekend';
  destinations: [string, string];
  rows: TimetableRow[];
}

function timeCell(raw: string): string | null {
  if (/^[-—–/\s]+$/.test(raw)) return null;
  const time = cleanTime(raw);
  if (!time || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid operator timetable cell: ${raw}`);
  }
  const [h, m] = time.split(':');
  return `${h!.padStart(2, '0')}:${m}`;
}

export function parseTimetableArticle(html: string): TimetableSection[] {
  const sections: TimetableSection[] = [];
  let line: string | undefined;
  let calendar: TimetableSection['calendar'] | undefined;
  let previousEnd = 0;
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const heading = textOf(html.slice(previousEnd, table.index));
    previousEnd = table.index! + table[0].length;
    const lineMatch = /([1-9]\d*)号线(?:各站)?首末班车时间/.exec(heading);
    if (lineMatch) {
      line = lineMatch[1];
      calendar = undefined;
    }
    if (heading.includes('非工作日')) calendar = 'weekend';
    else if (heading.includes('工作日')) calendar = 'weekday';

    const rows = [...table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textOf(c[1]!))
    );
    const directionRow = rows.find((r) => r.length === 5 && r[1]?.startsWith('往'));
    if (!directionRow) continue; // Peak/off-peak and page-layout tables.
    if (!line || !calendar) throw new Error('Timetable table has no line/calendar heading');
    const destinations = directionRow
      .slice(1, 3)
      .map((s) => s.replace(/^往/, '').replace(/方向$/, ''));
    const data: TimetableRow[] = [];
    for (const r of rows) {
      if (!/^\d+$/.test(r[0] ?? '')) continue;
      if (r.length !== 6 || Number(r[0]) !== data.length + 1) {
        throw new Error(`Line ${line}: malformed or missing timetable row`);
      }
      data.push({
        station: r[1]!,
        first: [timeCell(r[2]!), timeCell(r[3]!)],
        last: [timeCell(r[4]!), timeCell(r[5]!)]
      });
    }
    if (data.length < 2) throw new Error(`Line ${line}: empty timetable`);
    sections.push({ line, calendar, destinations: destinations as [string, string], rows: data });
  }
  for (const lineId of ['1', '2']) {
    for (const day of ['weekday', 'weekend']) {
      if (sections.filter((s) => s.line === lineId && s.calendar === day).length !== 1) {
        throw new Error(`Expected exactly one Line ${lineId} ${day} timetable`);
      }
    }
  }
  return sections;
}
