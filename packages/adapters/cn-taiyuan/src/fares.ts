/**
 * OD fare matrix for Taiyuan Metro.
 *
 * The operator's own route planner (`busExt` — the backend behind the
 * "路线查询" page on `www.tymetro.ltd`) quotes the single-journey fare for
 * an OD pair in `buslist[0].expense`.
 *
 * The published tariff is a distance ladder — 起步价 2 元可乘坐 5 公里；
 * 5 公里以上部分，票价每增加 1 元的晋级里程为 5、5、6、6、7 公里，不设置
 * 封顶票价 — so the planner quotes agree with the operator's fare rules
 * (verified against the announced 2号线 full-line maximum of 6 元).
 */
import { type FareSpec, proxyUrl } from '@openmetro/core';

import { fetchPlannerRoute, type PlannerStation } from './fetch.js';

/**
 * Rebuild the planner station map from the canonical `stations.json`.
 *
 * The fares layer can run on its own (`data:sync --layer fares`), so the
 * planner keys must be recoverable from disk rather than from a live fetch.
 */
export async function loadTaiyuanPlannerKeys(
  dataDir: string
): Promise<Map<string, TaiyuanPlannerKey>> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const doc = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')) as {
    records: {
      id: string;
      name: string;
      location?: { lon?: number; lat?: number };
      extras?: { amap_poiid?: string };
    }[];
  };
  const out = new Map<string, TaiyuanPlannerKey>();
  for (const st of doc.records ?? []) {
    const poiid = st.extras?.amap_poiid;
    const lon = st.location?.lon;
    const lat = st.location?.lat;
    if (!poiid || lon == null || lat == null) continue;
    out.set(poiid, { name: st.name, lon, lat, poiid });
  }
  return out;
}

export const TY_FARE_SOURCE_NAME = 'Taiyuan Metro official route planner (busExt)';
export const TY_FARE_SOURCE_URL =
  'https://webapi.amap.com/subway/service/navigation/busExt?x1={lon}&y1={lat}&x2={lon}&y2={lat}&poiid1={poiid}&poiid2={poiid}&type=6&Ver=3';

export interface TaiyuanPlannerKey extends PlannerStation {
  /** AMap POI id — the planner's station key. */
  poiid: string;
}

/**
 * Fare spec backed by the operator's route planner.
 *
 * `byPoiid` maps the AMap POI id to the coordinates the planner needs.
 */
export function createTaiyuanFareSpec(byPoiid: Map<string, TaiyuanPlannerKey>): FareSpec {
  return {
    networkId: 'cn-taiyuan',
    currency: 'CNY',
    unit: 'yuan',
    source: {
      name: TY_FARE_SOURCE_NAME,
      url: TY_FARE_SOURCE_URL,
      version: '2026',
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: 'Taiyuan Metro (太原地铁)',
      notes:
        "Ordinary single-journey fare per OD pair from the operator's own route planner (the backend of the 路线查询 page on www.tymetro.ltd). Matches the published distance tariff: 2 元 for the first 5 km, then +1 元 per 5/5/6/6/7 km, no cap. The matrix is harvested via --layer fares."
    },
    keyOf: (station) => {
      const extras = station.extras as { amap_poiid?: string } | undefined;
      return extras?.amap_poiid || station.name;
    },
    query: async (a, b) => {
      if (!a || !b || a === b) return { price: null, retry: false };
      const from = byPoiid.get(a);
      const to = byPoiid.get(b);
      if (!from || !to) return { price: null, retry: false };
      const res = await fetchPlannerRoute(from, to);
      const route = res?.buslist?.[0];
      const price = Number(route?.expense);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    }
  };
}

/**
 * Official tariff for a ride of `km` kilometres, straight from the published
 * distance ladder. Used to cross-check the planner quotes.
 */
export function officialTariffFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  let limit = 5;
  let fare = 2;
  const steps = [5, 5, 6, 6, 7];
  for (const step of steps) {
    if (km <= limit) return fare;
    limit += step;
    fare += 1;
  }
  while (km > limit) {
    limit += 7;
    fare += 1;
  }
  return fare;
}

/** Exposed for diagnostics: the planner URL for one OD pair. */
export function plannerUrl(from: PlannerStation, to: PlannerStation): string {
  return proxyUrl(
    `https://webapi.amap.com/subway/service/navigation/busExt?x1=${from.lon}&y1=${from.lat}&x2=${to.lon}&y2=${to.lat}&poiid1=${from.poiid}&poiid2=${to.poiid}&type=6&Ver=3`
  );
}
