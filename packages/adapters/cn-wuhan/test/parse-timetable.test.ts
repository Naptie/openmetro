import { test, expect } from 'bun:test';
import { parseTimetableArticle } from '../src/normalize.ts';

/**
 * Regression: direction headers whose endpoints contain "车站"
 * (e.g. 武汉火车站) were rejected as table-header rows, which left
 * `activeDirs` empty and dropped every data row — Line 4 had zero
 * published first/last trains.
 */
const line4Article = `
<html><body>
<div>
<p>4号线工作日各站首末班车时间（6:00-23:00）</p>
<table>
<tr><td>4号线工作日首末班车时间</td></tr>
<tr><td>上行（武汉火车站-柏林）</td><td>下行（柏林-武汉火车站）</td></tr>
<tr><td>车站</td><td>首班车</td><td>末班车</td><td>车站</td><td>首班车</td><td>末班车</td></tr>
<tr><td>武汉火车站</td><td>6:00</td><td>23:00</td><td>柏林</td><td>6:00</td><td>23:00</td></tr>
<tr><td>杨春湖</td><td>6:01</td><td>23:01</td><td>新庙村</td><td>6:02</td><td>23:02</td></tr>
<tr><td>柏林</td><td>——</td><td>00:26（到达）</td><td>武汉火车站</td><td>——</td><td>00:26（到达）</td></tr>
</table>
</div>
</body></html>
`;

test('parses dual-column timetable when endpoints contain 车站', () => {
  const sections = parseTimetableArticle(line4Article);
  expect(sections.length).toBeGreaterThan(0);
  const dirs = sections[0]!.directions;
  expect(dirs.length).toBe(2);
  expect(dirs[0]!.origin).toBe('武汉火车站');
  expect(dirs[0]!.terminal).toBe('柏林');
  expect(dirs[1]!.origin).toBe('柏林');
  expect(dirs[1]!.terminal).toBe('武汉火车站');
  expect(dirs[0]!.rows.length).toBeGreaterThanOrEqual(2);
  expect(dirs[1]!.rows.length).toBeGreaterThanOrEqual(2);
  expect(dirs[0]!.rows[0]!.station).toBe('武汉火车站');
  expect(dirs[0]!.rows[0]!.first).toBe('6:00');
});

test('still skips the 车站 | 首班车 | 末班车 table header', () => {
  const sections = parseTimetableArticle(line4Article);
  const stations = sections.flatMap((s) => s.directions.flatMap((d) => d.rows.map((r) => r.station)));
  expect(stations).not.toContain('车站');
  expect(stations).not.toContain('首班车');
});
