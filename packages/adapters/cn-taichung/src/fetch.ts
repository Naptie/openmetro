import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { type OfficialStation, parseCsv, type TaichungSources } from './normalize.js';

const resource = (id: string) =>
  `https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=${id}`;
export const SOURCES = {
  stations: resource('f9511cc5-4799-4df9-98b7-0b0f89fc2be9'),
  fares: resource('261c5b91-8f02-4c17-8a97-23c1384eced7'),
  runtimes: resource('4edec91c-05c8-4dee-9f93-7ab3cef20fc3'),
  timetables: 'https://www.tmrt.com.tw/metro-life/first-last-train',
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
  const props = (text: string) => {
    const next = text.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!next) throw new Error('TMRT station payload missing');
    return JSON.parse(next).props.pageProps;
  };
  const officialStations = props(html!).stationsData as OfficialStation[];
  if (!Array.isArray(officialStations) || officialStations.length < 2)
    throw new Error('Missing TMRT stations');
  const journeys: TaichungSources['journeys'] = [];
  // One official origin table covers every destination. Bound concurrency.
  for (let i = 0; i < officialStations.length; i += 4) {
    const rows = await Promise.all(
      officialStations.slice(i, i + 4).map(async (s) => {
        const other = officialStations.find((t) => t.ID !== s.ID)!;
        const url = `${SOURCES.officialStations}?${new URLSearchParams({ start: s.ID, stop: other.ID })}`;
        const table = props(await getText(url)).stationTableDataInit as TaichungSources['journeys'];
        if (
          !Array.isArray(table) ||
          table.length !== officialStations.length - 1 ||
          table.some((r) => r.StartSiteName.trim() !== s.SiteName.trim())
        )
          throw new Error(`Incomplete/mismatched TMRT journey table ${s.SiteCode}`);
        return table;
      })
    );
    journeys.push(...rows.flat());
  }
  return {
    officialStations,
    stations: parseCsv(stations!),
    fares: JSON.parse(fares!.replace(/^\uFEFF/, '')),
    runtimes: parseCsv(runtimes!),
    serviceStations: props(timetables!).stationsData,
    journeys
  };
}
