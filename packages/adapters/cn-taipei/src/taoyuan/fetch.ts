import { createHash } from 'node:crypto';
import {
  decodeFeed,
  type FareMatrixEncoded,
  fetchFeed,
  fetchFeedEnrichment,
  localTimeParts,
  type OsmFeed
} from '@openmetro/core';
import { parseTaoyuanQuotes, parseTaoyuanStations } from './normalize.js';

const BASE = 'https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/';
export interface TaoyuanSources {
  stationPage: string;
  quotes: unknown[];
  departureDays: { date: string; pages: Record<string, string> }[];
  osm: OsmFeed;
  sources: FareMatrixEncoded['source'];
}
export async function fetchTaoyuanSources(now = new Date()): Promise<TaoyuanSources> {
  const sources: FareMatrixEncoded['source'][number][] = [];
  const text = async (name: string, url: string, init?: RequestInit) => {
    const bytes = await fetchFeed(url, init);
    sources.push({
      name,
      url,
      version: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: '桃園大眾捷運股份有限公司',
      notes: init?.body ? `Public planner request: ${String(init.body)}` : undefined
    });
    return decodeFeed(bytes);
  };
  const planner = async (code: string): Promise<unknown> =>
    JSON.parse(
      await text(`taoyuan-planner-${code}`, `${BASE}fetch_data.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ station_id: `station_${code}`, kind: '1' })
      })
    );
  const stationPage = await text('taoyuan-stations', `${BASE}road.php`),
    first = await planner('A1');
  const active = new Set(
    parseTaoyuanQuotes(first)
      .filter((q) => q.seconds > 0)
      .flatMap((q) => [q.from, q.to])
  );
  const stations = parseTaoyuanStations(stationPage, active),
    quotes: unknown[] = [first],
    departureDays: TaoyuanSources['departureDays'] = [];
  for (let i = 0; i < stations.length; i += 4) {
    await Promise.all(
      stations.slice(i, i + 4).map(async (s) => {
        const q = s.code === 'A1' ? undefined : await planner(s.code);
        if (q) quotes.push(q);
      })
    );
  }
  const start = localTimeParts(now, 'Asia/Taipei').date;
  // A two-week dated snapshot overlaps the weekly sync schedule. No day's
  // first/last window is silently projected onto an unqueried service date.
  let validThrough: string | undefined;
  for (let offset = 0; offset < 14; offset++) {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + offset * 86400_000)
      .toISOString()
      .slice(0, 10);
    if (validThrough && date > validThrough) break;
    const pages: Record<string, string> = {};
    for (let i = 0; i < stations.length; i += 4) {
      await Promise.all(
        stations.slice(i, i + 4).map(async (s) => {
          const url = `${BASE}departure.php?${new URLSearchParams({ station: s.code, godate: date })}`;
          // The site's date picker stores this public preference cookie;
          // departure.php ignores godate alone and needs no server session.
          const html = await text(`taoyuan-timetable-${s.code}-${date}`, url, {
            headers: { Cookie: `tymetro_new_chdate=${date}` }
          });
          const returnedDate = html.match(/name="godate"[^>]*value="([^"]+)"/)?.[1];
          if (returnedDate !== date)
            throw new Error(`Taoyuan returned another service date for ${s.code}: ${returnedDate}`);
          const expiry = html.match(/更新至\s*(\d{3,4})\/(\d{1,2})\/(\d{1,2})/);
          if (!expiry) throw new Error('Taoyuan timetable validity notice missing');
          const year = Number(expiry[1]) + (Number(expiry[1]) < 1911 ? 1911 : 0);
          const end = `${year}-${expiry[2]!.padStart(2, '0')}-${expiry[3]!.padStart(2, '0')}`;
          if (validThrough && validThrough !== end)
            throw new Error('Taoyuan source validity changed during synchronization');
          validThrough = end;
          if (date > end) throw new Error(`Taoyuan timetable is not published for ${date}`);
          pages[s.code] = html;
        })
      );
    }
    departureDays.push({ date, pages });
  }
  return {
    stationPage,
    quotes,
    departureDays,
    osm: await fetchFeedEnrichment([24.85, 121.05, 25.25, 121.85]),
    sources: sources.sort((a, b) => a.name.localeCompare(b.name))
  };
}
