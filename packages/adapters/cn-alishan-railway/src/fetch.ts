import { adapterCacheDir, decodeFeed, fetchRailResource, mapRailResources } from '@openmetro/core';
import { fetchRailOsm, railServiceDate } from '@openmetro/taiwan-shared';
import {
  NETWORK_ID,
  parseAlishanBranches,
  parseAlishanMain,
  parseAlishanTables
} from './normalize.js';

type Source = Awaited<ReturnType<typeof fetchRailResource>>['source'];
export interface AlishanSources {
  date: string;
  main: string;
  branches: string;
  fares: string;
  mileage: string;
  home: string;
  osm: Awaited<ReturnType<typeof fetchRailOsm>>['osm'];
  sources: Source[];
}
export async function fetchAlishanSources(): Promise<AlishanSources> {
  const cache = adapterCacheDir(NETWORK_ID);
  const pages = {
    main: '0000115',
    branches: '0000300',
    fares: '0000119',
    mileage: '0000120',
    home: ''
  };
  const results = await mapRailResources(Object.entries(pages), async ([key, path]) => {
    const resource = await fetchRailResource(
      `https://afrch.forest.gov.tw/${path}`,
      cache,
      undefined,
      (bytes) => {
        const html = decodeFeed(bytes);
        if (key === 'main') return parseAlishanMain(html);
        if (key === 'branches') return parseAlishanBranches(html);
        if (key === 'home') {
          if (!html.includes('阿里山')) throw new Error('Forest railway homepage missing');
          return;
        }
        const tables = parseAlishanTables(html);
        if (
          !tables.length ||
          (key === 'fares' &&
            !['票價表', '支線別'].every((label) => tables.some((table) => table[0]?.[0] === label)))
        )
          throw new Error(`Forest railway ${key} table missing`);
      }
    );
    return { key, text: decodeFeed(resource.bytes), source: resource.source };
  });
  const enrichment = await fetchRailOsm(cache);
  return {
    date: railServiceDate(),
    ...Object.fromEntries(results.map((result) => [result.key, result.text])),
    osm: enrichment.osm,
    sources: [...results.map((result) => result.source), enrichment.source]
  } as AlishanSources;
}
