import { createHash } from 'node:crypto';
import {
  enrichFeedStations,
  fetchFeed,
  fetchFeedEnrichment,
  fetchFeedText,
  htmlText,
  type OsmFeed,
  zipMember
} from '@openmetro/core';
import { fetchTaiwanServiceCalendar } from '@openmetro/taiwan-shared';
import { type DepartureWindow, parseStationTable } from './normalize.js';
import { createTimetableOcr } from './raster-timetables.js';

const BASE = 'https://www.ntmetro.com.tw';
export interface NewTaipeiSources {
  pages: Record<string, string>;
  osm: OsmFeed;
  departures: {
    code: string;
    text: string;
    url: string;
    windows?: DepartureWindow[];
    sha256?: string;
  }[];
  farePairs: { from: string; to: string; price: number }[];
  runtimePairs?: { from: string; to: string; seconds: number; url: string; sha256: string }[];
  sourceImages?: { name: string; url: string; sha256: string }[];
  serviceCalendar?: Awaited<ReturnType<typeof fetchTaiwanServiceCalendar>>['calendar'];
  calendarSource?: Awaited<ReturnType<typeof fetchTaiwanServiceCalendar>>['source'];
}
export function odtParagraphs(xml: string): string {
  const body = xml.slice(xml.indexOf('<office:body'));
  return [...body.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
    .map((m) => htmlText(m[1]!).replace(/\s+/g, ''))
    .join('\n');
}
/** Content media are separate from the site's system logos and footer links. */
export function contentImage(html: string): string {
  const paths = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((p) => /\/archive\/(file|images)\//.test(p) && !p.includes('footer'));
  if (paths.length !== 1)
    throw new Error(`Official page content image changed: ${paths.length} candidates`);
  return new URL(paths[0]!, BASE).href;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function fetchNewTaipeiSources(): Promise<NewTaipeiSources> {
  const { calendar: serviceCalendar, source: calendarSource } = await fetchTaiwanServiceCalendar();
  const pages: Record<string, string> = Object.fromEntries(
    await Promise.all(
      Object.entries({ v: 10136, k: 10137, y: 10138, lb: 10164 }).map(async ([key, n]) => [
        key,
        await fetchFeedText(`${BASE}/basic/?node=${n}`)
      ])
    )
  );
  const stationCodes = Object.fromEntries(
    Object.entries(pages).map(([k, p]) => [k, parseStationTable(p).map((s) => s.code)])
  );
  const osm = await fetchFeedEnrichment([24.85, 121.05, 25.25, 121.85]);
  const stationNames = Object.fromEntries(
    enrichFeedStations(parseStationTable(pages.lb!), osm).map((s) => [
      s.code,
      [s.zh, s.en].filter(Boolean)
    ])
  );
  // The operator appends Danhai's blue branch outward after the green main line.
  const v = stationCodes.v!;
  stationCodes.v = [
    ...v.filter((c) => Number(c.slice(1)) <= 11),
    ...v
      .filter((c) => Number(c.slice(1)) >= 26)
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
  ];
  const departures: NewTaipeiSources['departures'] = [],
    farePairs: NewTaipeiSources['farePairs'] = [],
    runtimePairs: NonNullable<NewTaipeiSources['runtimePairs']> = [],
    sourceImages: NonNullable<NewTaipeiSources['sourceImages']> = [];
  const reader = await createTimetableOcr();
  try {
    for (const entry of [460, 602, 796]) {
      const index = await fetchFeedText(`${BASE}/basic/?mode=detail&node=${entry}`),
        links = new Map<string, string>();
      for (const m of index.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const code = htmlText(m[2]!).match(/^((?:V|K|Y)\d{2})/)?.[1];
        if (code && m[1]!.includes('mode=detail'))
          links.set(code, new URL(m[1]!.replaceAll('&amp;', '&'), `${BASE}/basic/`).href);
      }
      if (!links.size) throw new Error(`Official timetable category is empty: ${entry}`);
      const entries = [...links];
      for (let i = 0; i < entries.length; i += 4) {
        const batch = await Promise.allSettled(
          entries.slice(i, i + 4).map(async ([code, url]) => {
            const html = await fetchFeedText(url);
            if (code.startsWith('Y')) {
              const path = html.match(/href="([^"]+\.pdf)"/)?.[1];
              if (!path) throw new Error(`Official PDF missing ${code}`);
              const pdfUrl = new URL(path, BASE).href,
                bytes = await fetchFeed(pdfUrl),
                y = stationCodes.y!;
              return {
                code,
                url: pdfUrl,
                text: '',
                windows: await reader
                  .read(
                    bytes,
                    [y.at(-1)!, y[0]!].filter((c) => c !== code),
                    code
                  )
                  .catch((error) => {
                    throw new Error(`Official PDF OCR failed for ${code}: ${pdfUrl}`, {
                      cause: error
                    });
                  }),
                sha256: hash(bytes)
              };
            }
            const path = html.match(/href="([^"]+\.odt)"/)?.[1];
            if (!path) throw new Error(`Official ODT missing ${code}`);
            const docUrl = new URL(path, BASE).href,
              text = odtParagraphs(zipMember(await fetchFeed(docUrl), 'content.xml'));
            if (
              !text
                .split('\n')
                .find((s) => s)
                ?.includes(code)
            )
              throw new Error(`Official timetable station mismatch ${code}`);
            return { code, url: docUrl, text };
          })
        );
        for (const result of batch) {
          if (result.status === 'rejected') throw result.reason;
          departures.push(result.value);
        }
      }
    }
    // This official aggregate poster supplies every Sanying station, two first-
    // train day types, last trains, and a separate Bannan connection cutoff.
    const lbUrl = contentImage(await fetchFeedText(`${BASE}/basic/?mode=detail&node=863`)),
      lbBytes = await fetchFeed(lbUrl),
      lbHash = hash(lbBytes);
    const lbRows = await reader.readStationTable(lbBytes, stationCodes.lb!, stationNames);
    departures.push(...lbRows.map((row) => ({ ...row, text: '', url: lbUrl, sha256: lbHash })));
    sourceImages.push({ name: 'sanying-first-last', url: lbUrl, sha256: lbHash });

    for (const [key, node] of Object.entries({ v: 10097, k: 10098, y: 10103, lb: 10165 })) {
      const url = contentImage(await fetchFeedText(`${BASE}/basic/?node=${node}`)),
        bytes = await fetchFeed(url),
        sha256 = hash(bytes),
        codes = stationCodes[key]!;
      const paths = key === 'v' ? [codes.slice(0, 11), ['V09', ...codes.slice(11)]] : [codes];
      const edges = paths.flatMap((p) =>
        p.slice(1).map((to, i) => [p[i]!, to] as [string, string])
      );
      const values = await reader.readRuntimeTable(bytes, codes, edges);
      runtimePairs.push(...values.map((v) => ({ ...v, url, sha256 })));
      sourceImages.push({ name: `${key}-official-running-times`, url, sha256 });
    }
    for (const [key, node] of Object.entries({ v: 10105, k: 10106, y: 10107, lb: 10166 })) {
      const url = contentImage(await fetchFeedText(`${BASE}/basic/?node=${node}`)),
        bytes = await fetchFeed(url);
      farePairs.push(...(await reader.readFareTable(bytes, stationCodes[key]!)));
      sourceImages.push({ name: `${key}-official-fares`, url, sha256: hash(bytes) });
    }
  } finally {
    await reader.close();
  }
  return {
    pages,
    departures,
    farePairs,
    runtimePairs,
    sourceImages,
    serviceCalendar,
    calendarSource,
    osm
  };
}
