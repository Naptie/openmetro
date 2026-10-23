import { expect, test } from 'bun:test';
import { matrixFromWorkbook } from '../src/fares.ts';
import {
  colIndex,
  colLetters,
  downloadFareWorkbookBytes,
  type FareWorkbook,
  parseFareWorkbook
} from '../src/fetch.ts';

/**
 * The operator's published fare workbook is external input, the same class of
 * thing as the JSON payloads every other adapter downloads: fetch it fresh,
 * keep it in memory, commit nothing. The bytes never reach the repository.
 *
 * An unreachable source is an environment problem, not a parser regression,
 * so it skips during local development. Under CI the workflow is expected to
 * be self-contained, so there it fails loudly instead — set
 * `OPENMETRO_TEST_OFFLINE=1` to downgrade that failure to a skip.
 */
const requireLiveSource = Boolean(process.env.CI) && process.env.OPENMETRO_TEST_OFFLINE !== '1';

let bytes: Buffer | null = null;
let unreachable: string | null = null;
try {
  bytes = await downloadFareWorkbookBytes();
} catch (err) {
  unreachable = err instanceof Error ? err.message : String(err);
}

// A parse failure below is deliberately left uncaught: the workbook was
// downloaded fine, so its layout no longer matches what the parser expects —
// a genuine regression that must fail everywhere, never a skip.
const workbook: FareWorkbook | null = bytes ? parseFareWorkbook(bytes) : null;

if (unreachable && !requireLiveSource) {
  console.warn(`SKIP official fare workbook is unreachable: ${unreachable}`);
}

test('column letter round-trip', () => {
  expect(colIndex('A')).toBe(0);
  expect(colIndex('C')).toBe(2);
  expect(colIndex('GO')).toBe(196);
  expect(colLetters(0)).toBe('A');
  expect(colLetters(196)).toBe('GO');
});

if (requireLiveSource) {
  test('the official fare workbook is reachable', () => {
    if (unreachable) {
      throw new Error(`official fare workbook is unreachable: ${unreachable}`);
    }
    expect(workbook).not.toBeNull();
  });
}

test.skipIf(!workbook)('parses the official fare workbook layout', () => {
  const wb = workbook!;
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

test.skipIf(!workbook)('re-keys the workbook onto canonical stations and symmetrises', () => {
  const wb = workbook!;
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
