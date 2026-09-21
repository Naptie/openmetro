import { type FareSpec, proxyUrl } from '@openmetro/core';

/**
 * Hangzhou Metro official ticket inquiry (`/api/operation/fare`).
 * Stations are keyed by the Chinese display name published in
 * `operation/all.stationlist.stationName`.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-hangzhou',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Hangzhou Metro ticket inquiry',
    url: 'https://www.hzmetro.com/api/operation/fare',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Hangzhou Metro (杭州地铁)',
    notes:
      'Ordinary single-journey fare per OD pair from the official site ticket inquiry. Mileage-based fare policy; matrix harvested explicitly via --layer fares.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    const url = proxyUrl('https://www.hzmetro.com/api/operation/fare');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.hzmetro.com/'
        },
        body: new URLSearchParams({ startStationName: a, endStationName: b }).toString(),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as { ok?: boolean; data?: string | number | null };
      if (!j.ok) return { price: null, retry: false };
      const raw = j.data;
      if (raw == null || raw === '--' || raw === '') return { price: null, retry: false };
      const price = Number(raw);
      // Same-station / degenerate pairs sometimes return the network minimum.
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
