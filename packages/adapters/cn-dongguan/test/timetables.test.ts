import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseTimetableArticle } from '../src/timetables.js';

const article = readFileSync(new URL('./fixtures/timetable.html', import.meta.url), 'utf8');

test('parses current operator tables, preserving weekday and weekend differences', () => {
  const sections = parseTimetableArticle(article);
  expect(sections.map((s) => [s.line, s.calendar, s.rows.length])).toEqual([
    ['1', 'weekday', 25],
    ['1', 'weekend', 25],
    ['2', 'weekday', 15],
    ['2', 'weekend', 15]
  ]);
  expect(sections[0]!.destinations).toEqual(['东莞西站', '梅塘站']);
  expect(sections[2]!.destinations).toEqual(['虎门火车站', '东莞火车站']);
  expect(sections[0]!.rows[1]!.last).toEqual(['00:06', '23:03']);
  expect(sections[2]!.rows[7]!.first).toEqual(['06:35', '06:36']);
  expect(sections[3]!.rows[7]!.first).toEqual(['06:38', '06:33']);
  expect(sections[0]!.rows[0]!.first).toEqual([null, '06:30']);
});

test('refuses an incomplete calendar or malformed numeric timetable row', () => {
  expect(() => parseTimetableArticle(article.replace('06:38', 'bad'))).toThrow();
  expect(() => parseTimetableArticle(article.slice(0, article.lastIndexOf('<h3>')))).toThrow();
});
