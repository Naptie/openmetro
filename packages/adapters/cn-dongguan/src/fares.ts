import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, type FareMatrixEncoded, foldStationName } from '@openmetro/core';
import { fetchFareStations, getText, OPERATOR } from './fetch.js';

/** Do not treat an empty/error response as a zero fare or a successful harvest. */
export function parseFareResponse(raw: unknown, from: number, to: number): number {
  const r = raw as {
    info?: { success?: boolean };
    data?: { price?: string; startStation?: { id?: number }; endStation?: { id?: number } }[];
  };
  const quote = r?.data?.[0];
  if (
    !r?.info?.success ||
    r.data?.length !== 1 ||
    quote?.startStation?.id !== from ||
    quote?.endStation?.id !== to ||
    !/^\d+(?:\.\d+)?$/.test(quote?.price ?? '')
  ) {
    throw new Error(`Invalid operator fare quote for ${from} → ${to}`);
  }
  const price = Number(quote!.price);
  if (price < 2 || price > 100) throw new Error(`Implausible operator fare: ${price}`);
  return price;
}

export function emptyFareMatrix(stations: { id: string }[]) {
  const sorted = [...stations].sort((a, b) => a.id.localeCompare(b.id));
  return {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-dongguan',
    generated_at: new Date().toISOString(),
    source: [],
    currency: 'CNY',
    unit: 'yuan',
    basis: 'base',
    station_ids: sorted.map((s) => s.id),
    fares: sorted.map((_, i) => sorted.map<number | null>((_, j) => (i === j ? 0 : null)))
  } satisfies FareMatrixEncoded;
}

export async function harvestFares(
  stations: { id: string; name: string }[],
  previous?: FareMatrixEncoded
): Promise<FareMatrixEncoded> {
  const catalog = await fetchFareStations();
  const keyByName = new Map(catalog.map((s) => [foldStationName(s.name), s.id]));
  const names = new Set(stations.map((s) => foldStationName(s.name)));
  for (const station of catalog) {
    if (!names.has(foldStationName(station.name)))
      throw new Error(`Unmatched fare station: ${station.name}`);
  }
  const matrix = emptyFareMatrix(stations);
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const keys = matrix.station_ids.map((id) =>
    keyByName.get(foldStationName(stationById.get(id)!.name))
  );
  const currentIndex = new Map(matrix.station_ids.map((id, i) => [id, i]));
  if (previous) {
    for (let i = 0; i < previous.station_ids.length; i++) {
      const a = currentIndex.get(previous.station_ids[i]!);
      if (a == null) continue;
      for (let j = i + 1; j < previous.station_ids.length; j++) {
        const b = currentIndex.get(previous.station_ids[j]!);
        if (b != null && previous.fares[i]![j] != null && (keys[a] == null || keys[b] == null))
          throw new Error('Operator fare catalog lost previously covered stations');
      }
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i] != null && keys[j] != null) pairs.push([i, j]);
    }
  }
  if (pairs.length === 0) throw new Error('No canonical stations match the operator fare catalog');
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < pairs.length) {
        const [i, j] = pairs[next++]!;
        const url = `${OPERATOR}ext/ticketPrice.htmx?startId=${keys[i]}&endId=${keys[j]}`;
        const price = parseFareResponse(JSON.parse(await getText(url)), keys[i]!, keys[j]!);
        matrix.fares[i]![j] = matrix.fares[j]![i] = price;
        await new Promise((r) => setTimeout(r, 80));
      }
    })
  );
  const source: FareMatrixEncoded['source'] = [
    {
      name: 'dggdjt-ticketPrice',
      url: `${OPERATOR}ext/ticketPrice.htmx`,
      version: 'live',
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: '东莞市轨道交通有限公司',
      notes:
        'Operator base fares, excluding temporary discounts. The legacy catalog currently contains only Line 2; unmatched Line 1/cross-line pairs remain null. No fares are inferred from straight-line distances.'
    }
  ];
  console.log(
    `  official base fares: ${pairs.length}/${(stations.length * (stations.length - 1)) / 2} OD pairs`
  );
  return { ...matrix, source };
}

export async function syncDongguanFares(dataDir: string): Promise<void> {
  const stations = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf8')).records as {
    id: string;
    name: string;
  }[];
  const previous = await readFile(join(dataDir, 'fares.json'), 'utf8').then(JSON.parse);
  const fares = await harvestFares(stations, previous);
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(fares, null, 2)}\n`);
}
