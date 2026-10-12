import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@openmetro/core';
import { matrixFromWorkbook } from '../src/fares.ts';
import { colIndex, colLetters, parseFareWorkbook } from '../src/fetch.ts';

/** The cached workbook lives in the adapter scratch cache at the repo root. */
const workbookPath = join(
  findRepoRoot(import.meta.dir),
  'tmp/cache/cn-qingdao/official-fare-table.xlsx'
);

test('column letter round-trip', () => {
  expect(colIndex('A')).toBe(0);
  expect(colIndex('C')).toBe(2);
  expect(colIndex('GO')).toBe(196);
  expect(colLetters(0)).toBe('A');
  expect(colLetters(196)).toBe('GO');
});

test('parses the official fare workbook layout', () => {
  const buf = readFileSync(workbookPath);
  const wb = parseFareWorkbook(buf);
  expect(wb.header.length).toBe(195);
  expect(wb.rows.length).toBe(195);
  // Blocks follow the line order; first row is 1号线 王家港, last 西海岸快线.
  expect(wb.rows[0]!.line).toBe('1号线');
  expect(wb.rows[0]!.station).toBe('王家港');
  expect(wb.rows.at(-1)!.line).toBe('西海岸快线');
  expect(wb.rows.at(-1)!.station).toBe('董家口火车站');
  // 胶州北站 → 董家口火车站 = 12 yuan (official pjSearch quote).
  const jiaozhou = wb.rows.find((r) => r.station === '胶州北站')!;
  const col = wb.header.indexOf('董家口火车站');
  expect(jiaozhou.fares[col]).toBe(12);
  // Diagonal pairs are the boarding fare (2), not zero: the workbook prices
  // a station against itself at the minimum fare.
  const wangjiagang = wb.rows.find((r) => r.station === '王家港')!;
  const selfCol = wb.header.indexOf('王家港');
  expect(wangjiagang.fares[selfCol]).toBe(2);
});

test('re-keys the workbook onto canonical stations and symmetrises', () => {
  const buf = readFileSync(workbookPath);
  const wb = parseFareWorkbook(buf);
  const stations = [
    { id: 'cn-qingdao-wangjiagang', name: '王家港' },
    { id: 'cn-qingdao-dongjiakou-railway-station', name: '董家口火车站' },
    { id: 'cn-qingdao-jiaozhou-north-railway-station', name: '胶州北站' }
  ];
  const matrix = matrixFromWorkbook(wb, stations);
  expect(matrix.stationIds).toEqual(stations.map((s) => s.id));
  expect(matrix.fares.length).toBe(3);
  for (const row of matrix.fares) expect(row.length).toBe(3);
  // Diagonal forced to 0; mirror pairs equal.
  expect(matrix.fares[0]![0]).toBe(0);
  const a = matrix.fares[1]![2];
  const b = matrix.fares[2]![1];
  expect(a).toBe(b);
  expect(a).toBe(12);
});
