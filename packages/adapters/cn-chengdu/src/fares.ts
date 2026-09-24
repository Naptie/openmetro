import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, type FareSpec, proxyUrl } from '@openmetro/core';
import { fetchTravel } from './fetch.js';

/**
 * Chengdu Rail Transit official trip planner (`getTravel.jsp`).
 * Stations are keyed by the Chinese display name published in `/op/station-time`
 * (annotations stripped). `price` is the ordinary single-journey fare in yuan.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-chengdu',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: 'Chengdu Rail Transit getTravel trip planner',
    url: 'https://www.chengdurail.com/system/resource/cddt/getTravel.jsp',
    version: '2026',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: '成都轨道交通集团有限公司',
    notes:
      'Ordinary single-journey fare per OD pair from the official site trip query. Mileage-based fare policy; matrix harvested via --layer fares.'
  },
  keyOf: (station) => station.name,
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const plans = await fetchTravel(a, b, 2);
      const plan = plans[0];
      const price = Number(plan?.price);
      return { price: Number.isFinite(price) && price > 0 ? price : null, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};

/**
 * Official published mileage fare policy (行程查询 · 基本票价政策).
 * 起价 2 元 / 4 km; 4–12 +1/4 km; 12–24 +1/6 km; 24–40 +1/8 km;
 * 40–50 +1/10 km; >50 +1/20 km.
 */
export function chengduMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 4) return 2;
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
 * Replace with planner harvest via `--layer fares` / `--fares`.
 */
export async function writeChengduFormulaFares(dataDir: string): Promise<void> {
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
      const price = chengduMileageFare(km);
      matrix[i]![j] = price;
      matrix[j]![i] = price;
    }
  }
  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-chengdu',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '成都地铁里程计价制 + station coordinates',
        url: 'https://www.chengdurail.com/xccxjgy.jsp?urltype=tree.TreeTempUrl&wbtreeid=2142',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '成都轨道交通集团有限公司',
        notes:
          'Formula fares from the official published mileage tariff applied to AMap station distances ×1.25 detour. Replace with planner harvest via --layer fares.'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: stations.map((s) => s.id),
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote formula fares.json (${n}x${n})`);
}

/** Re-export for runners that want the live fetch helper. */
export { fetchTravel, proxyUrl };
