/**
 * Fares for cn-fuzhou.
 *
 * The official 票价线路查询 page (`/services/routeQuery`) is backed by a real
 * endpoint, `GET /api/system/way/list?startStation=&endStation=`, which serves
 * the operator's precomputed OD route table: route legs (line, direction,
 * station sequence) plus the single-journey fare. Stations are keyed by
 * display name; the plain interchange name and the operator's suffixed
 * variant (`三叉街` / `三叉街（滨海快线）`) both resolve.
 *
 * The sync layer (`syncFares`) enumerates the upper triangle once per pair;
 * ~5,000 pairs at a modest rate. The table excludes unopened stations, so
 * every operating pair has a row (same-station pairs return none by design).
 */
import { type FareSpec, officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { WAY_LIST_API } from './fetch.js';

interface WayListRow {
  startStation?: string;
  endStation?: string;
  price?: string | number | null;
  wayType?: string;
}

interface WayListResponse {
  code?: number;
  msg?: string;
  data?: { rows?: WayListRow[]; total?: string | number } | null;
}

export const fareSpec: FareSpec = {
  networkId: 'cn-fuzhou',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Fuzhou Metro fare & route query',
    url: 'https://www.fzmtr.com/api/system/way/list',
    version: '2026-02 (precomputed OD table)',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Fuzhou Metro Group (福州地铁集团)',
    notes:
      'Ordinary single-journey fare per OD pair from the official site route query backend. Mileage-based fare policy; matrix harvested explicitly via --layer fares.'
  },
  keyOf: (station) => station.names.zh,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    const url = proxyUrl(
      `${WAY_LIST_API}?${new URLSearchParams({
        startStation: a,
        endStation: b,
        pageNum: '1',
        pageSize: '10'
      }).toString()}`
    );
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({
          Accept: 'application/json',
          Referer: 'https://www.fzmtr.com/services/routeQuery'
        }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as WayListResponse;
      if (j.code !== 200) return { price: null, retry: false };
      const row = j.data?.rows?.[0];
      const raw = row?.price;
      if (raw == null || raw === '') return { price: null, retry: false };
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
