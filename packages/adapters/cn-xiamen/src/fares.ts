import { type FareSpec, officialFetchHeaders, proxyUrl } from '@openmetro/core';

const XM_CMS = 'https://www.xmgdjt.com.cn';

/**
 * Xiamen Metro official fare inquiry (`/api/transit/fare/route`).
 *
 * Stations are keyed by the operator's own station id (the CMS id carried on
 * `stops.source_id` — shared across lines at interchanges). The planner only
 * holds numeric-id stations (lines 1–3); UUID-id stations (most of lines 4/6)
 * return an empty array, which the matrix stores as `null` — the schema's
 * documented "operator publishes no fare for this pair" case.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-xiamen',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Xiamen Metro fare inquiry',
    url: 'https://www.xmgdjt.com.cn/api/transit/fare/route',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: '厦门轨道交通集团有限公司 (Xiamen Rail Transit Group)',
    notes:
      '普通单程票价 per OD pair from the official website fare inquiry (fareType=1). ' +
      'The response also carries the OD mileage and station count; the matrix keeps the fare only. ' +
      'UUID-id stations (lines 4/6 and two Line-2 western stops) have no published fare and stay null.'
  },
  keyOf: (station, stopCode) => stopCode(station.id) ?? '',
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    const url = proxyUrl(
      `${XM_CMS}/api/transit/fare/route?startStationId=${encodeURIComponent(a)}&endStationId=${encodeURIComponent(b)}&fareType=1`
    );
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({ Referer: `${XM_CMS}/` }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const rows = (await res.json()) as { fare?: number | string | null }[] | null;
      if (!Array.isArray(rows) || rows.length === 0) return { price: null, retry: false };
      const fare = Number(rows[0]?.fare);
      if (!Number.isFinite(fare) || fare <= 0) return { price: null, retry: false };
      return { price: fare, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
