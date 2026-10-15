import { expect, test } from 'bun:test';
import { timetableArticleUrl } from '../src/fetch.js';

test('discovers a replacement operator article rather than retaining the old id', () => {
  const index =
    '<a href="/node/121.htmx">服务时间</a><a href="/info/99999.htmx" title="运营时间">运营时间</a>';
  expect(timetableArticleUrl(index)).toBe('https://www.dggdjt.com/info/99999.htmx');
  expect(() =>
    timetableArticleUrl('<a href="https://example.com/info/1.htmx">服务时间</a>')
  ).toThrow();
});
