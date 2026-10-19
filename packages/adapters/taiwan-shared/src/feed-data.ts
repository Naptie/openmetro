import {
  entitySchemaUrl,
  type FareMatrixEncoded,
  type NetworkEncoded,
  placeholderCity
} from '@openmetro/core';

export function feedNetwork(
  id: string,
  cityId: string,
  zh: string,
  en: string,
  notes: string
): NetworkEncoded {
  return {
    id,
    name: zh,
    names: { zh, en },
    city: placeholderCity(cityId),
    country_code: 'CN',
    currency: 'TWD',
    timezone: 'Asia/Taipei',
    coordinate_system: 'wgs84',
    default_units: { distance: 'km', time: 's', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 180, max_transfer_seconds: 900 },
    notes,
    service_scope: notes
  };
}

export function feedFares(
  networkId: string,
  topology: { stations: readonly { id: string }[] },
  sources: FareMatrixEncoded['source'],
  pairs: { from: string; to: string; price: number }[]
): FareMatrixEncoded {
  const ids = topology.stations.map((s) => s.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const fares: (number | null)[][] = ids.map((_, i) => ids.map((_, j) => (i === j ? 0 : null)));
  for (const { from, to, price } of pairs) {
    const i = index.get(from),
      j = index.get(to);
    if (i == null || j == null || i === j) continue;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid fare ${from} -> ${to}`);
    const old = fares[i]![j];
    if (old != null && old !== price)
      throw new Error(`Conflicting fares ${from} -> ${to}: ${old}/${price}`);
    fares[i]![j] = price;
    fares[j]![i] = price;
  }
  return {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: networkId,
    generated_at: new Date().toISOString(),
    source: sources,
    currency: 'TWD',
    unit: 'NT$',
    station_ids: ids,
    fares
  };
}
