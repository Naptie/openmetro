import { type FareSpec, proxyUrl } from '@openmetro/core';
import { fetchNanjingFare } from './fetch.js';

/**
 * Nanjing Metro official ticket inquiry (`mobileTicketAction/getPrice.do`).
 * Stations are keyed by the Chinese display name published in
 * `get-stationList.do`. The site double-URL-encodes names.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-nanjing',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Nanjing Metro ticket inquiry',
    url: 'https://www.njmetro.com.cn/njdtweb/mobileTicketAction/getPrice.do',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Nanjing Metro (南京地铁)',
    notes:
      'Ordinary single-journey fare per OD pair from the official site ticket inquiry (same-station defaults to 2). Mileage-based fare policy; matrix harvested explicitly via --layer fares.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const price = await fetchNanjingFare(a, b);
      if (price == null) return { price: null, retry: true };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
