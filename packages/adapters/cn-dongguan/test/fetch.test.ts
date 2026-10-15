import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fetchDongguanSources, timetableArticleUrl } from '../src/fetch.js';

test('discovers a replacement operator article rather than retaining the old id', () => {
  const index =
    '<a href="/node/121.htmx">服务时间</a><a href="/info/99999.htmx" title="运营时间">运营时间</a>';
  expect(timetableArticleUrl(index)).toBe('https://www.dggdjt.com/info/99999.htmx');
  expect(() =>
    timetableArticleUrl('<a href="https://example.com/info/1.htmx">服务时间</a>')
  ).toThrow();
});

test('keeps the current article while a newer announcement is not effective yet', async () => {
  const amap = readFileSync(new URL('./fixtures/amap.json', import.meta.url), 'utf8');
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('amap.com')) return new Response(amap);
    if (url.includes('/node/121'))
      return new Response(
        '<li><a href="/info/200.htmx">运营服务时间</a><span>2026-10-05</span></li>' +
          '<li><a href="/info/100.htmx">运营服务时间</a><span>2025-01-01</span></li>'
      );
    return new Response(
      url.includes('/200.') ? '<p>2099年1月1日起执行</p>' : '<p>Current timetable</p>'
    );
  });
  try {
    expect((await fetchDongguanSources()).timetableUrl).toBe(
      'https://www.dggdjt.com/info/100.htmx'
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test('selects the newest published timetable even when an old article is pinned', () => {
  const index = [
    '<li><a href="/info/100.htmx">运营服务时间</a><span>2025-01-01</span></li>',
    '<li><a href="/info/300.htmx">运营服务时间</a><span>2099-01-01</span></li>',
    '<li><a href="/info/200.htmx">运营服务时间</a><span>2026-10-05</span></li>'
  ].join('');
  expect(timetableArticleUrl(index)).toBe('https://www.dggdjt.com/info/200.htmx');
});
