import { type FareSpec, proxyUrl } from '@openmetro/core';

// Public web-app credentials the Guangzhou map client itself ships; required
// by the route planner API.
const GZ_ACCESSKEY = '247919A174804353AE72BAB00981C6E8';
const GZ_TOKEN = '38c7e7b3ka1f3k44dak8707k806a1f8bf978';

/**
 * Guangzhou Metro's official route planner. Stations are keyed by display
 * name (Chinese); the planner is a POST endpoint with fixed app credentials.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-gz',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Guangzhou Metro route planner',
    url: 'https://apis.gzmtr.com/app-map/metroweb/route/{start}/{end}',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Guangzhou Metro (广州地铁)',
    notes: 'Fare per OD pair from the official route planner.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    const url = proxyUrl(
      `https://apis.gzmtr.com/app-map/metroweb/route/${encodeURIComponent(a)}/${encodeURIComponent(
        b
      )}?auto_type=key&acccesskey=${GZ_ACCESSKEY}`
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GZ_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) return { price: null, retry: true };
    const j = (await res.json()) as {
      success?: boolean;
      businessObject?: { price?: number };
    };
    if (!j.success) return { price: null, retry: false };
    const price = Number(j.businessObject?.price);
    return { price: Number.isFinite(price) ? price : null, retry: false };
  }
};
