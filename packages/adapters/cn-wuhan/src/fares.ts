import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, type FareSpec, proxyUrl } from '@openmetro/core';

/**
 * Wuhan Metro official route planner (advh5 `/lmap/route`, the endpoint the
 * official site's trip query calls). Stations are keyed by Chinese display
 * name. `amount` is the ordinary single-journey fare.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-wuhan',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Wuhan Metro lmap route planner',
    url: 'https://advh5.whrtmpay.com/lmap/route',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: 'Wuhan Metro (武汉地铁)',
    notes:
      'Ordinary single-journey fare per OD pair from the official site trip query. Mileage-based fare policy; matrix harvested via --layer fares.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const res = await fetch(proxyUrl('https://advh5.whrtmpay.com/lmap/route'), {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json',
          Referer: 'https://www.wuhanrt.com/',
          Accept: 'application/json, text/plain, */*'
        },
        body: JSON.stringify({ startStationName: a, endStationName: b, jsVersion: 3 }),
        signal: AbortSignal.timeout(40_000)
      });
      if (!res.ok) return { price: null, retry: true };
      const j = (await res.json()) as {
        success?: boolean;
        rtData?: { buslist?: { amount?: number | string }[] };
      };
      if (!j.success || !j.rtData?.buslist?.length) return { price: null, retry: false };
      const price = Number(j.rtData.buslist[0]?.amount);
      return { price: Number.isFinite(price) && price > 0 ? price : null, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};

/** Official published mileage fare policy (metro-operation.html / 票务规定). */
export function wuhanMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 2;
  if (km <= 4) return 2;
  if (km <= 12) return 2 + Math.ceil((km - 4) / 4);
  if (km <= 24) return 4 + Math.ceil((km - 12) / 6);
  if (km <= 40) return 6 + Math.ceil((km - 24) / 8);
  if (km <= 50) return 8 + Math.ceil((km - 40) / 10);
  return 9 + Math.ceil((km - 50) / 20);
}

function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Bootstrap fares.json from the official mileage policy + station coordinates.
 * Used when live OD harvest is skipped so the dataset stays complete; replace
 * with planner harvest via `--fares` / `--layer fares`.
 */
export async function writeWuhanFormulaFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as {
      id: string;
      name: string;
      location?: { lon: number; lat: number };
    }[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const n = stations.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );
  // Metro paths are longer than straight lines; 1.25 is a typical urban detour factor.
  const DETOUR = 1.25;
  for (let i = 0; i < n; i++) {
    const a = stations[i]!.location;
    for (let j = i + 1; j < n; j++) {
      const b = stations[j]!.location;
      if (!a || !b) continue;
      const km = haversineKm(a, b) * DETOUR;
      const price = wuhanMileageFare(km);
      matrix[i]![j] = price;
      matrix[j]![i] = price;
    }
  }
  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-wuhan',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: 'Wuhan Metro mileage fare policy + station coordinates',
        url: 'https://www.wuhanrt.com/metro-operation.html',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: 'Wuhan Metro (武汉地铁)',
        notes:
          'Formula fares from the official published mileage tariff applied to AMap station distances ×1.25 detour. Replace with planner harvest via --layer fares.'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: stations.map((s) => s.id),
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document)}\n`, 'utf-8');
  console.log(`  wrote formula fares.json (${n}x${n})`);
}
