import { type FareSpec, proxyUrl } from "@openmetro/core";

/**
 * Shanghai Metro's official path & fare planner. Stations are keyed by the
 * official per-line stop code (`stops.source_id`).
 */
export const fareSpec: FareSpec = {
  networkId: "cn-sh",
  currency: "CNY",
  unit: "yuan",
  source: {
    name: "Shanghai Metro route & fare planner",
    url: "https://m.shmetro.com/interface/plantrip/pt.aspx",
    version: "2026",
    retrieved_at: new Date().toISOString(),
    license: "unknown",
    license_url: null,
    attribution: "Shanghai Metro (上海地铁)",
    notes: "Fare per OD pair from the official path & fare planner.",
  },
  keyOf: (station, stopCode) => stopCode(station.id) ?? "",
  query: async (a, b) => {
    const url = proxyUrl(
      `https://m.shmetro.com/interface/plantrip/pt.aspx?func=plantrip&startId=${encodeURIComponent(
        a,
      )}&endId=${encodeURIComponent(b)}&planTime=00:59&week=1&ticket=oneWay&type=0`,
    );
    // The planner redirects to an error page under load (and for the rare
    // unroutable pair), so treat every redirect as transient and retry.
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400) return { price: null, retry: true };
    if (!res.ok) return { price: null, retry: true };
    const text = await res.text();
    if (text.startsWith("<")) return { price: null, retry: true };
    const j = JSON.parse(text) as { pathList?: { price?: string }[] };
    const price = Number(j.pathList?.[0]?.price);
    return { price: Number.isFinite(price) ? price : null, retry: false };
  },
};
