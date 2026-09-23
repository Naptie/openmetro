import { entitySchemaUrl, type FareMatrixEncoded } from '@openmetro/core';
import type { AirportExpressFareRow, MtrFareRow } from './fetch.js';

/**
 * Fare names in the two CSVs are slightly inconsistent:
 *   mtr_lines_fares: "Hong Kong", "AsiaWorld-Expo", "Tsing Yi"
 *   airport_express: "HongKong", "AsiaWorld-Expo", "Tsing Yi"
 */
export function foldFareName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[''`']/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface FareMatrixInput {
  networkId: string;
  stationIds: string[];
  /** Folded English name → canonical station id. */
  stationIdByFoldedName: Map<string, string>;
  fares: MtrFareRow[];
  airportExpressFares: AirportExpressFareRow[];
}

/**
 * Build the symmetric OD fare matrix from MTR open-data CSVs.
 *
 * `mtr_lines_fares.csv` covers the heavy-rail network (adult Octopus).
 * `airport_express_fares.csv` overrides AEL pairs, which are priced as a
 * separate product and are absent from / inconsistent with the urban matrix.
 */
export function buildFareMatrix(input: FareMatrixInput): FareMatrixEncoded {
  const n = input.stationIds.length;
  const indexOf = new Map(input.stationIds.map((id, i) => [id, i]));
  const fares: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const setFare = (a: string, b: string, price: number) => {
    const i = indexOf.get(a);
    const j = indexOf.get(b);
    if (i == null || j == null || i === j) return;
    if (!Number.isFinite(price) || price < 0) return;
    fares[i][j] = price;
    fares[j][i] = price;
  };

  for (const row of input.fares) {
    const a = input.stationIdByFoldedName.get(foldFareName(row.srcName));
    const b = input.stationIdByFoldedName.get(foldFareName(row.destName));
    if (!a || !b) continue;
    setFare(a, b, row.octAdtFare);
  }

  // Airport Express is a separate product; prefer its published adult Octopus fare.
  for (const row of input.airportExpressFares) {
    const a = input.stationIdByFoldedName.get(foldFareName(row.srcName));
    const b = input.stationIdByFoldedName.get(foldFareName(row.destName));
    if (!a || !b) continue;
    setFare(a, b, row.octAdtFare);
  }

  return {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: input.networkId,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: 'MTR lines and stations fares (adult Octopus)',
        url: 'https://opendata.mtr.com.hk/data/mtr_lines_fares.csv',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: 'MTR Corporation Limited (港鐵公司)',
        notes: 'Ordinary adult Octopus fare per OD pair from MTR open data.'
      },
      {
        name: 'MTR Airport Express fares (adult Octopus)',
        url: 'https://opendata.mtr.com.hk/data/airport_express_fares.csv',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: 'MTR Corporation Limited (港鐵公司)',
        notes:
          'Airport Express is priced as a separate product; these fares override the urban matrix for AEL pairs.'
      }
    ],
    currency: 'HKD',
    unit: 'dollar',
    station_ids: input.stationIds,
    fares
  };
}
