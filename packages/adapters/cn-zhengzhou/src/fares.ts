import { type FareSpec, proxyUrl } from '@openmetro/core';

/**
 * Zhengzhou Metro official trip planner (`api.zzmetro.com/api/price`).
 * Stations are keyed by the official `zid` published in `/api/stations`
 * (same id stored as `stops.source_id`).
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-zhengzhou',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Zhengzhou Metro api/price',
    url: 'https://api.zzmetro.com/api/price?begin={zid}&end={zid}&type=distance',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Zhengzhou Metro (郑州地铁)',
    notes:
      'Ordinary single-journey fare per OD pair from the official trip planner. Mileage-based; matrix harvested via --layer fares.'
  },
  keyOf: (station, stopCode) => {
    const codes = (station.extras as { official_zids?: string[] } | undefined)?.official_zids;
    return codes?.[0] || stopCode(station.id) || station.name;
  },
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    const url = proxyUrl(
      `https://api.zzmetro.com/api/price?begin=${encodeURIComponent(a)}&end=${encodeURIComponent(
        b
      )}&type=distance`
    );
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.zzmetro.com/lines/query/ticket'
        },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { price?: number | string };
      };
      if (!j.status || !j.data) return { price: null, retry: false };
      const price = Number(j.data.price);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
