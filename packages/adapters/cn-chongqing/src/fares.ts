import { type FareSpec, proxyUrl } from '@openmetro/core';

/**
 * Chongqing Rail Transit official OD fare planner
 * (`TakeLine!queryYsTakeLine.action`). Stations are keyed by Chinese display
 * name. Ordinary single-journey fare; 市郊铁路 (江跳线/璧铜线) may return empty.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-chongqing',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Chongqing Rail Transit trip query',
    url: 'https://www.cqmetro.cn/Front/html/TakeLine!queryYsTakeLine.action',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Chongqing Rail Transit (重庆轨道交通)',
    notes:
      'Ordinary single-journey fare per OD pair from the official site trip query. Mileage-based fare policy (市郊铁路 excluded). Matrix harvested via --layer fares.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const qs = new URLSearchParams({
        'entity.startStaName': a,
        'entity.endStaName': b
      });
      const res = await fetch(
        proxyUrl(
          `https://www.cqmetro.cn/Front/html/TakeLine!queryYsTakeLine.action?${qs.toString()}`
        ),
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.cqmetro.cn/xcgh/'
          },
          signal: AbortSignal.timeout(30_000)
        }
      );
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as {
        success?: boolean;
        result?: { price?: number | string }[];
      };
      if (!j.success) return { price: null, retry: false };
      const raw = j.result?.[0]?.price;
      if (raw == null) return { price: null, retry: false };
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
