import { type FareSpec, officialFetchHeaders, proxyUrl } from '@openmetro/core';

/**
 * Shenzhen Metro official route planner (`MinTimeJson.do`).
 * Stations are keyed by official 4-digit codes from the map feed (`0101`).
 * `ticketPrice` is the ordinary single-journey fare.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-shenzhen',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Shenzhen Metro MinTimeJson route planner',
    url: 'https://www.szmc.net/algorithm/Ticketing/MinTimeJson.do',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Shenzhen Metro (深圳地铁)',
    notes:
      'Ordinary single-journey fare per OD pair from the official map route planner. Mileage-based fare policy; matrix harvested monthly.'
  },
  keyOf: (station) => {
    const codes = (station.extras as { official_codes?: string[] } | undefined)?.official_codes;
    return codes?.[0] || station.name;
  },
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    const url = proxyUrl(
      `https://www.szmc.net/algorithm/Ticketing/MinTimeJson.do?departureStation=${encodeURIComponent(
        a
      )}&arriveStation=${encodeURIComponent(b)}&ridingType=0`
    );
    try {
      const res = await fetch(url, {
        headers: officialFetchHeaders({ Referer: 'https://www.szmc.net/map/' }),
        signal: AbortSignal.timeout(40_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const text = await res.text();
      if (!text.trim().startsWith('{')) return { price: null, retry: true };
      const j = JSON.parse(text) as { ticketPrice?: number | string };
      const price = Number(j.ticketPrice);
      return { price: Number.isFinite(price) && price > 0 ? price : null, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};
