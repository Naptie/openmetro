import { adapterCacheDir, decodeFeed, fetchRailResource, mapRailResources } from '@openmetro/core';
import { fetchRailOsm, railServiceDate } from '@openmetro/taiwan-shared';
import { NETWORK_ID, parseThsrQuote, parseThsrStations } from './normalize.js';

type Source = Awaited<ReturnType<typeof fetchRailResource>>['source'];
export interface ThsrSources {
  date: string;
  stationPage: string;
  osm: Awaited<ReturnType<typeof fetchRailOsm>>['osm'];
  quotes: { from: string; to: string; data: unknown }[];
  sources: Source[];
}
export async function fetchThsrSources(): Promise<ThsrSources> {
  const cache = adapterCacheDir(NETWORK_ID),
    date = railServiceDate();
  const enrichment = await fetchRailOsm(cache);
  const stationResource = await fetchRailResource(
    'https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c',
    cache,
    undefined,
    (bytes) => parseThsrStations(decodeFeed(bytes), enrichment.osm)
  );
  const stationPage = decodeFeed(stationResource.bytes);
  const stations = parseThsrStations(stationPage, enrichment.osm),
    sources: Source[] = [stationResource.source, enrichment.source];
  if (stations.length < 2) throw new Error('Empty THSR station selector');
  const pairs = stations.flatMap((from, i) =>
    stations.slice(i + 1).map((to) => [from, to] as const)
  );
  pairs.push(...stations.slice(1).map((from, i) => [from, stations[i]!] as const));
  const quotes = await mapRailResources(pairs, async ([from, to]) => {
    const body = new URLSearchParams({
      SearchType: 'S',
      Lang: 'TW',
      StartStation: from.query,
      EndStation: to.query,
      OutWardSearchDate: date.replaceAll('-', '/'),
      OutWardSearchTime: '00:00',
      ReturnSearchDate: '',
      ReturnSearchTime: '',
      DiscountType: ''
    }).toString();
    const resource = await fetchRailResource(
      'https://www.thsrc.com.tw/TimeTable/Search',
      cache,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      },
      (bytes) => parseThsrQuote(JSON.parse(decodeFeed(bytes)), { from: from.zh, to: to.zh, date })
    );
    sources.push(resource.source);
    const data = JSON.parse(decodeFeed(resource.bytes));
    return { from: from.code, to: to.code, data };
  });
  return { date, stationPage, osm: enrichment.osm, quotes, sources };
}
