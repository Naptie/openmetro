import { type FareSpec, proxyUrl } from '@openmetro/core';

/**
 * Beijing Subway's official map fare search. Stations are keyed by display
 * name (Chinese) — the planner has no public station id space.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-beijing',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Beijing Subway map fare search',
    url: 'https://map.bjsubway.com/searchstartend',
    version: '20260630',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Beijing Subway (北京地铁)',
    notes: 'Fare per OD pair from the official map route planner.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    const url = proxyUrl(
      `https://map.bjsubway.com/searchstartend?start=${encodeURIComponent(
        a
      )}&end=${encodeURIComponent(b)}&mintype=1&time=12:00`
    );
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://map.bjsubway.com/' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) return { price: null, retry: true };
    const j = (await res.json()) as { result?: string; price?: number };
    if (j.result !== 'success') return { price: null, retry: false };
    const price = Number(j.price);
    return { price: Number.isFinite(price) ? price : null, retry: false };
  }
};
