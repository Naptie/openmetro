import { expect, test } from 'bun:test';
import { changshaMileageFare, decodeHtmlEntities } from '../src/lines.ts';
import { buildCalendarArrays, classifyCalendar, parseOfficialTimes } from '../src/timetables.ts';

test("the operator's `times` rows parse into their published directions", () => {
  // One row per service direction, labelled `origin—destination`.
  const entries = parseOfficialTimes(
    '#1号线（金盆丘—尚双塘）首车：6:30 末车：23:00\r\n#1号线（尚双塘—金盆丘）首车：6:33 末车：23:28'
  );
  expect(entries).toHaveLength(2);
  expect(entries[0]!.lineLabel).toBe('1号线');
  expect(entries[0]!.originLabel).toBe('金盆丘');
  expect(entries[0]!.destinationLabel).toBe('尚双塘');
  expect(entries[0]!.first).toBe('6:30');
  expect(entries[0]!.last).toBe('23:00');
  expect(entries[1]!.destinationLabel).toBe('金盆丘');
  expect(entries[1]!.directionOnly).toBe(false);
});

test('a station name with brackets does not break the label', () => {
  // 3号线's 松雅湖（南） carries full-width brackets inside the label, and the
  // label is closed by the last `）` before `首车`.
  const entries = parseOfficialTimes('#3号线（松雅湖（南）—广生）首车：6:30 末车：23:56');
  expect(entries).toHaveLength(1);
  expect(entries[0]!.originLabel).toBe('松雅湖（南）');
  expect(entries[0]!.destinationLabel).toBe('广生');
});

test('Line 3 publishes three destinations from one station', () => {
  const entries = parseOfficialTimes(
    [
      '#3号线（月湖公园北—广生）首车：6:30 末车：23:56',
      '#3号线（月湖公园北—红桥）首车：6:33 末车：23:16',
      '#3号线（月湖公园北—湘潭北）首车：6:33 末车：21:04'
    ].join('\r\n')
  );
  expect(entries.map((e) => e.destinationLabel)).toEqual(['广生', '红桥', '湘潭北']);
});

test('the maglev publishes a direction-only label and two calendars', () => {
  const entries = parseOfficialTimes(
    [
      '#磁浮快线（往机场方向）首车：7:07 末车：22:17。（工作日（不含节假日前一天））',
      '<br>',
      '#磁浮快线（往机场方向）首车：7:07 末车：22:37。（双休日、节假日（含节假日前一天））'
    ].join('\r\n')
  );
  expect(entries).toHaveLength(2);
  expect(entries[0]!.directionOnly).toBe(true);
  expect(entries[0]!.destinationLabel).toBe('机场');
  expect(entries[0]!.originLabel).toBeUndefined();
  expect(entries[0]!.calendar).toBe('工作日（不含节假日前一天）');
  expect(entries[1]!.calendar).toBe('双休日、节假日（含节假日前一天）');
});

test('a weekday note is not mistaken for a weekend note', () => {
  // `节假日前一天` contains the substring `节假日`, so the weekday marker has
  // to be tested first — otherwise both maglev variants land in the same
  // bucket and the weekday times are dropped.
  expect(classifyCalendar('工作日（不含节假日前一天）')).toBe('weekday');
  expect(classifyCalendar('双休日、节假日（含节假日前一天）')).toBe('weekend');
  expect(classifyCalendar(undefined)).toBeUndefined();
});

test('a single published variant stays a one-element array', () => {
  const entries = parseOfficialTimes('#1号线（金盆丘—尚双塘）首车：6:30 末车：23:00');
  const { first, last } = buildCalendarArrays(entries);
  expect(first).toEqual(['6:30']);
  expect(last).toEqual(['23:00']);
});

test('two calendar variants become a seven-element weekday array', () => {
  const entries = parseOfficialTimes(
    [
      '#磁浮快线（往机场方向）首车：7:07 末车：22:17。（工作日（不含节假日前一天））',
      '#磁浮快线（往机场方向）首车：7:07 末车：22:37。（双休日、节假日（含节假日前一天））'
    ].join('\r\n')
  );
  const { first, last } = buildCalendarArrays(entries);
  // Mon–Fri from the weekday variant, Sat–Sun from the weekend variant.
  expect(first).toEqual(['7:07', '7:07', '7:07', '7:07', '7:07', '7:07', '7:07']);
  expect(last).toEqual(['22:17', '22:17', '22:17', '22:17', '22:17', '22:37', '22:37']);
});

test("the CMS's HTML entities are decoded before the name is corrected", () => {
  // The operator stores the maglev station's 榔 as the entity `&#15294;`.
  expect(decodeHtmlEntities('磁浮&#15294;梨站')).toBe('磁浮㮾梨站');
  expect(decodeHtmlEntities('磁浮榔梨站')).toBe('磁浮榔梨站');
  expect(decodeHtmlEntities('松雅湖（南）')).toBe('松雅湖（南）');
});

test('the published mileage tariff matches the operator policy', () => {
  // 起步价 2 元可乘 6 公里（含）；6—16 公里每递增 5 公里加 1 元；
  // 16—30 公里每递增 7 公里加 1 元；30 公里以上每递增 9 公里加 1 元。
  expect(changshaMileageFare(0)).toBe(2);
  expect(changshaMileageFare(6)).toBe(2);
  expect(changshaMileageFare(6.01)).toBe(3);
  expect(changshaMileageFare(11)).toBe(3);
  expect(changshaMileageFare(11.01)).toBe(4);
  expect(changshaMileageFare(16)).toBe(4);
  expect(changshaMileageFare(16.01)).toBe(5);
  expect(changshaMileageFare(23)).toBe(5);
  expect(changshaMileageFare(23.01)).toBe(6);
  expect(changshaMileageFare(30)).toBe(6);
  expect(changshaMileageFare(30.01)).toBe(7);
  expect(changshaMileageFare(39)).toBe(7);
  expect(changshaMileageFare(39.01)).toBe(8);
  expect(changshaMileageFare(48)).toBe(8);
  expect(changshaMileageFare(48.01)).toBe(9);
});

test('the tariff reproduces the planner quotes of the sampled journeys', () => {
  // Baidu's own quotes for the sampled Changsha OD pairs, checked against
  // the ladder applied to the planner's own rail mileage.
  expect(changshaMileageFare(4.029)).toBe(2);
  expect(changshaMileageFare(5.493)).toBe(2);
  expect(changshaMileageFare(7.038)).toBe(3);
  expect(changshaMileageFare(10.634)).toBe(3);
  expect(changshaMileageFare(12.357)).toBe(4);
  expect(changshaMileageFare(14.964)).toBe(4);
  expect(changshaMileageFare(16.654)).toBe(5);
  expect(changshaMileageFare(17.005)).toBe(5);
  expect(changshaMileageFare(26.612)).toBe(6);
  expect(changshaMileageFare(34.078)).toBe(7);
  expect(changshaMileageFare(41.087)).toBe(8);
});
