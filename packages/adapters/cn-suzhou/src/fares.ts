import { type OriginFareSpec, proxyUrl, syncFaresFromOrigins } from '@openmetro/core';
import { fetchTransTickets } from './fetch.js';

/**
 * Suzhou publishes one-origin → all-destinations fares on the official map
 * (`getTransTickets.do`). Destinations are keyed by the operator's 4-digit
 * station code — the same id used as `stops.source_id`.
 */
export function suzhouFareSpec(): OriginFareSpec {
  return {
    networkId: 'cn-suzhou',
    currency: 'CNY',
    unit: 'yuan',
    source: {
      name: 'Suzhou Metro getTransTickets',
      url: 'https://www.sz-mtr.com/admin/getTransTickets.do?sid={stationCode}',
      version: '2026',
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: 'Suzhou Rail Transit (苏州轨道交通)',
      notes: 'One-origin bulk fare list from the official map fare/time query.'
    },
    keyOf: (station, stopCode) => {
      const codes = (station.extras as { official_codes?: string[] } | undefined)?.official_codes;
      return codes?.[0] || stopCode(station.id) || station.name;
    },
    queryAll: async (originKey) => {
      const url = proxyUrl(
        `https://www.sz-mtr.com/admin/getTransTickets.do?sid=${encodeURIComponent(originKey)}`
      );
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.sz-mtr.com/service/guide/map/index_zh.html'
        },
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`getTransTickets ${originKey} -> ${res.status}`);
      const rows = (await res.json()) as { id?: string; price?: number }[];
      const out = new Map<string, number>();
      if (!Array.isArray(rows)) return out;
      for (const row of rows) {
        const price = Number(row.price);
        if (row.id && Number.isFinite(price)) out.set(String(row.id), price);
      }
      return out;
    }
  };
}

/**
 * One-to-all harvest into `<dataDir>/fares.json`. Cheap enough to run on every
 * full sync and on fares-only refreshes.
 */
export async function harvestSuzhouFares(dataDir: string): Promise<void> {
  console.log('  harvest one-to-all fares via getTransTickets');
  await syncFaresFromOrigins({ dataDir }, suzhouFareSpec(), {
    concurrency: 6,
    delayMs: 80
  });
}

/** Re-export for adapter runners that want the live fetch helper. */
export { fetchTransTickets };
