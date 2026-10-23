import { type FareSpec, proxyUrl } from '@openmetro/core';
import { NB_ROUTE_API, NB_SITE } from './fetch.js';

/**
 * Ningbo Rail Transit official route/fare query.
 *
 * `station.php?gostationTest/<from>/<to>/<strategy>` answers with the official
 * route, the interchange stations on it and the fare in CNY. Stations are keyed
 * by the official station id published in `station.php?stat` (the same id the
 * operator uses in the URL path).
 *
 * Fares are mileage-based and computed on the **shortest path through the
 * network**, so the matrix is topology-dependent: re-harvest after any
 * topology change.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-ningbo',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: '宁波轨道交通官方路径查询',
    url: `${NB_ROUTE_API}/{起点站id}/{终点站id}/1`,
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: '宁波轨道交通 (Ningbo Rail Transit)',
    notes:
      '官方单程票价，按进出站最短路径的里程分段计价（起步 4 公里 2 元，4-8 公里每 1 元乘 4 公里，8-13 公里每 1 元乘 5 公里，13-20 公里每 1 元乘 7 公里，20 公里以上每 1 元乘 9 公里）。逐 OD 采集，矩阵显式抓取。'
  },
  keyOf: (station, stopCode) => {
    const code = stopCode(station.id);
    if (code) return code;
    const official = station.extras?.official_station_id;
    return typeof official === 'string' ? official : '';
  },
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const res = await fetch(proxyUrl(`${NB_ROUTE_API}/${a}/${b}/1`), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: NB_SITE
        },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as {
        code?: string;
        price?: string | number | null;
      };
      if (j.code !== '200') return { price: null, retry: false };
      const raw = j.price;
      if (raw == null || raw === '--' || raw === '') return { price: null, retry: false };
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
