import { createHash } from 'node:crypto';
import { decodeFeed, fetchFeed, fetchFeedText, htmlText } from '@openmetro/core';

export const TAIPEI_DATASETS = {
  stations: '1eefa68d-7c8d-491b-8e75-66a161947426',
  routes: '733ff034-5a2b-442f-832a-c7d89add0ccb',
  timetables: '58e8be7e-3c77-4222-9d8c-26003c2a2cab',
  fares: '4acb4911-0360-4063-808d-fcee629508b3',
  transfers: '782c2b71-8f5a-4575-9bf2-e86999be2863'
} as const;

export type TaipeiDataset = keyof typeof TAIPEI_DATASETS;

export interface TaipeiResource {
  dataset_url: string;
  url: string;
  sha256: string;
  retrieved_at: string;
  resource_updated_at?: string;
  coverage_start?: string;
  coverage_end?: string;
}

export type TaipeiSources = Record<TaipeiDataset, string> & {
  resources: Record<TaipeiDataset, TaipeiResource>;
};

/** Discover the current resource instead of pinning a replaceable CSV resource id. */
export async function fetchTaipeiSources(): Promise<TaipeiSources> {
  const entries = await Promise.all(
    Object.entries(TAIPEI_DATASETS).map(async ([key, id]) => {
      const datasetUrl = `https://data.taipei/dataset/detail?id=${id}`;
      const page = await fetchFeedText(datasetUrl);
      const url = page.match(
        /https:\/\/data\.taipei\/api\/frontstage\/tpeod\/dataset\/resource\.download\?rid=[a-f0-9-]+/
      )?.[0];
      if (!url) throw new Error(`Taipei ${key}: official download link missing`);
      const bytes = await fetchFeed(url);
      const resourceRow = [...page.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
        .map((m) => m[0])
        .find((row) => row.includes(url));
      const updated = resourceRow?.match(/data-th="更新時間"[^>]*>([\s\S]*?)<\/td>/)?.[1];
      const metadata = new Map(
        [...page.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(
          (m) => [htmlText(m[1]!), htmlText(m[2]!)]
        )
      );
      const resource: TaipeiResource = {
        dataset_url: datasetUrl,
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        retrieved_at: new Date().toISOString(),
        resource_updated_at: updated ? htmlText(updated) : undefined,
        coverage_start: metadata.get('收錄期間(起)'),
        coverage_end: metadata.get('收錄期間(迄)')
      };
      return { key, text: decodeFeed(bytes), resource };
    })
  );
  return {
    ...Object.fromEntries(entries.map(({ key, text }) => [key, text])),
    resources: Object.fromEntries(entries.map(({ key, resource }) => [key, resource]))
  } as TaipeiSources;
}
