import { adapterCacheDir, decodeFeed, fetchRailResource, mapRailResources } from '@openmetro/core';
import { railServiceDate } from '@openmetro/taiwan-shared';
import {
  NETWORK_ID,
  normalizeTra,
  parseTraCatalog,
  parseTraDepartures,
  parseTraLocation,
  parseTraStationNames
} from './normalize.js';

const BASE = 'https://www.railway.gov.tw/tra-tip-web';
type Source = Awaited<ReturnType<typeof fetchRailResource>>['source'];
export interface TraSources {
  date: string;
  catalog: string;
  english: string;
  details: Record<string, string>;
  timetables: Record<string, string>;
  followingTimetables: Record<string, string>;
  sources: Source[];
}
export async function fetchTraSources(): Promise<TraSources> {
  const cache = adapterCacheDir(NETWORK_ID),
    sources: Source[] = [];
  const pages: { station: string; discard: () => Promise<void> }[] = [];
  const text = async (url: string, validate: (html: string) => unknown, station?: string) => {
    const resource = await fetchRailResource(url, cache, undefined, (bytes) =>
      validate(decodeFeed(bytes))
    );
    sources.push(resource.source);
    if (station) pages.push({ station, discard: resource.discard });
    return decodeFeed(resource.bytes);
  };
  const english = await text(`${BASE}/tip?lang=EN_US`, parseTraStationNames);
  const catalog = await text(`${BASE}/tip?lang=ZH_TW`, (html) => parseTraCatalog(html, english));
  const { stations } = parseTraCatalog(catalog, english);
  const date = railServiceDate();
  const followingDate = new Date(`${date}T12:00:00Z`);
  followingDate.setUTCDate(followingDate.getUTCDate() + 1);
  let completed = 0;
  const records = await mapRailResources(stations, async (station) => {
    const details = await text(
      `${BASE}/tip/tip00H/tipH41/viewStaInfo/${station.code}?lang=ZH_TW`,
      parseTraLocation
    );
    const query = new URLSearchParams({
      rideDate: date.replaceAll('-', '/'),
      station: `${station.code}-${station.zh}`
    });
    const timetable = await text(
      `${BASE}/tip/tip001/tip112/querybystationblank?${query}&lang=ZH_TW`,
      (html) => parseTraDepartures(html, station.code, station.zh, date),
      station.code
    );
    query.set('rideDate', followingDate.toISOString().slice(0, 10).replaceAll('-', '/'));
    const following = await text(
      `${BASE}/tip/tip001/tip112/querybystationblank?${query}&lang=ZH_TW`,
      (html) =>
        parseTraDepartures(
          html,
          station.code,
          station.zh,
          followingDate.toISOString().slice(0, 10)
        ),
      station.code
    );
    completed++;
    if (completed % 40 === 0)
      console.log(
        `[${NETWORK_ID}] fetched ${completed}/${stations.length} station service windows`
      );
    return { code: station.code, details, timetable, following };
  });
  const raw = {
    date,
    catalog,
    english,
    details: Object.fromEntries(records.map((record) => [record.code, record.details])),
    timetables: Object.fromEntries(records.map((record) => [record.code, record.timetable])),
    followingTimetables: Object.fromEntries(
      records.map((record) => [record.code, record.following])
    ),
    sources
  };
  try {
    normalizeTra(raw);
  } catch (error) {
    const affected = (error as { station_codes?: string[] }).station_codes;
    await Promise.all(
      pages
        .filter((page) => !affected || affected.includes(page.station))
        .map((page) => page.discard())
    );
    throw error;
  }
  return raw;
}
