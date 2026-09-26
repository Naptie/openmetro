import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, type FareSpec, type StationEncoded } from '@openmetro/core';
import { fetchTicketPrice } from './fetch.js';

/**
 * Xi'an Metro official ticket price (`/api-operational/ticketPrice/findByStartAndEnd`).
 * Stations are keyed by the official per-line station code (e.g. `0157`), taken
 * from the first line-stop of each physical station.
 */
export const fareSpec: FareSpec = {
  networkId: 'cn-xian',
  currency: 'CNY',
  unit: 'yuan',
  source: {
    name: "Xi'an Metro ticketPrice findByStartAndEnd",
    url: 'https://www.xianrail.com/pas-gateway-api/api-operational/ticketPrice/findByStartAndEnd',
    version: '20251231-2043',
    retrieved_at: new Date().toISOString(),
    license: 'unknown',
    license_url: null,
    attribution: '西安市轨道交通集团有限公司',
    notes:
      "Ordinary single-journey fare per OD pair from the official site ticket search. Matrix harvested via --layer fares; `privice` is the operator's fare field."
  },
  keyOf: (station: StationEncoded, stopCode: (stationId: string) => string | undefined) => {
    const extras = station.extras as
      | { fare_station_code?: string; official_codes?: string[] }
      | undefined;
    return (
      extras?.fare_station_code ||
      extras?.official_codes?.[0] ||
      stopCode(station.id) ||
      station.name
    );
  },
  query: async (a, b) => {
    if (!a || !b || a === b) return { price: null, retry: false };
    try {
      const row = await fetchTicketPrice(a, b);
      const price = Number(row?.privice);
      if (!Number.isFinite(price) || price <= 0) return { price: null, retry: false };
      return { price, retry: false };
    } catch {
      return { price: null, retry: true };
    }
  }
};

/**
 * Published Xi'an mileage tariff (里程计价制): 起步 2 元 / 6 km, then +1 元
 * per additional 6 km. Used only as a bootstrap matrix when the live OD API
 * is unreachable; `--layer fares` replaces cells with official quotes.
 */
export function xianMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 6) return 2;
  return 2 + Math.ceil((km - 6) / 6);
}

/** SSOT: @openmetro/core */
import { haversineKm } from '@openmetro/core';

/** Bootstrap fares.json from the mileage policy + station coordinates. */
export async function writeXianFormulaFares(
  dataDir: string,
  opts: { fillOnly?: boolean } = {}
): Promise<void> {
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
  // Urban metro paths run longer than straight lines; 1.20 matches sampled OD pairs.
  const DETOUR = 1.2;
  for (let i = 0; i < n; i++) {
    const a = stations[i]!.location;
    for (let j = i + 1; j < n; j++) {
      const b = stations[j]!.location;
      if (!a || !b) continue;
      const km = haversineKm(a, b) * DETOUR;
      const price = xianMileageFare(km);
      matrix[i]![j] = price;
      matrix[j]![i] = price;
    }
  }

  if (opts.fillOnly) {
    try {
      const existing = JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8')) as {
        station_ids: string[];
        fares: (number | null)[][];
      };
      const idx = new Map(existing.station_ids.map((id, i) => [id, i]));
      for (let i = 0; i < n; i++) {
        const oi = idx.get(stations[i]!.id);
        if (oi == null) continue;
        for (let j = 0; j < n; j++) {
          const oj = idx.get(stations[j]!.id);
          if (oj == null) continue;
          const prev = existing.fares[oi]?.[oj];
          if (prev != null) matrix[i]![j] = prev;
        }
      }
      const kept = matrix.flat().filter((v) => v != null).length;
      console.log(`  formula fillOnly: preserved ${kept} existing cells`);
    } catch {
      // no existing matrix — full formula bootstrap
    }
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-xian',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '西安地铁里程计价制 + AMap station coordinates',
        url: 'https://www.xianrail.com/',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '西安市轨道交通集团有限公司',
        notes:
          'Formula fares from the official mileage tariff (2 yuan / 6 km, +1 per 6 km) applied to AMap station distances ×1.20 detour. Replace with official OD harvest via --layer fares.'
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

/** Merge official OD quotes over an existing matrix (keeps formula cells where the API has no row). */
export async function mergeOfficialFares(
  dataDir: string,
  opts: { concurrency?: number; delayMs?: number } = {}
): Promise<void> {
  const concurrency = opts.concurrency ?? 8;
  const delayMs = opts.delayMs ?? 100;
  const faresPath = join(dataDir, 'fares.json');
  const document = JSON.parse(await readFile(faresPath, 'utf-8')) as {
    station_ids: string[];
    fares: (number | null)[][];
    source: unknown[];
  };
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationEncoded[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const codeOf = (s: StationEncoded): string => {
    const extras = s.extras as
      | { fare_station_code?: string; official_codes?: string[] }
      | undefined;
    return extras?.fare_station_code || extras?.official_codes?.[0] || s.name;
  };
  const codes = document.station_ids.map((id) => {
    const st = stations.find((s) => s.id === id);
    return st ? codeOf(st) : id;
  });

  const pairs: [number, number][] = [];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) pairs.push([i, j]);
  }
  console.log(`  official OD merge over ${pairs.length} pairs`);
  let next = 0;
  let updated = 0;
  let missing = 0;

  async function worker(): Promise<void> {
    while (true) {
      const pos = next++;
      if (pos >= pairs.length) return;
      const [i, j] = pairs[pos]!;
      try {
        const row = await fetchTicketPrice(codes[i]!, codes[j]!);
        const price = Number(row?.privice);
        if (Number.isFinite(price) && price > 0) {
          document.fares[i]![j] = price;
          document.fares[j]![i] = price;
          updated++;
        } else {
          missing++;
        }
      } catch {
        missing++;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pairs.length || 1) }, () => worker())
  );

  document.source = [
    {
      name: "Xi'an Metro ticketPrice findByStartAndEnd",
      url: 'https://www.xianrail.com/pas-gateway-api/api-operational/ticketPrice/findByStartAndEnd',
      version: new Date().toISOString(),
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: '西安市轨道交通集团有限公司',
      notes: `Official OD quotes merged over mileage-formula bootstrap (updated=${updated}, still-formula=${missing}).`
    }
  ];
  await writeFile(faresPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  merged official fares: updated=${updated} formula-kept=${missing}`);
}
