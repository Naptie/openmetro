import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { type OfficialStation, parseCsv, type TaichungSources } from './normalize.js';

const resource = (id: string) =>
  `https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=${id}`;
export const SOURCES = {
  stations: resource('f9511cc5-4799-4df9-98b7-0b0f89fc2be9'),
  fares: resource('261c5b91-8f02-4c17-8a97-23c1384eced7'),
  runtimes: resource('4edec91c-05c8-4dee-9f93-7ab3cef20fc3'),
  timetables: resource('fabf5eb7-c161-4b77-bf7c-6c6449fe5a89'),
  officialStations: 'https://www.tmrt.com.tw/metro-life/ride-time-and-fare'
};
async function getText(url: string): Promise<string> {
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders(),
        signal: AbortSignal.timeout(45000)
      });
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return await res.text();
    } catch (e) {
      error = e;
    }
  }
  throw error;
}
export async function fetchTaichung(): Promise<TaichungSources> {
  const [stations, fares, runtimes, timetables, html] = await Promise.all(
    Object.values(SOURCES).map(getText)
  );
  const next = html!.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!next) throw new Error('TMRT station payload missing');
  const officialStations = JSON.parse(next).props.pageProps.stationsData as OfficialStation[];
  return {
    officialStations,
    stations: parseCsv(stations!),
    fares: JSON.parse(fares!.replace(/^\uFEFF/, '')),
    runtimes: parseCsv(runtimes!),
    timetables: parseCsv(timetables!)
  };
}
