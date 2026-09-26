import type { FareMatrixEncoded } from '@openmetro/core';
import type { MlmFareTier } from './fetch.js';

const NETWORK_ID = 'cn-macau';

/** Fold traditional/simplified station names for matching. */
export function foldStationName(name: string): string {
  return name.trim().replace(/臺/g, '台').replace(/站$/, '').replace(/\s+/g, '').toLowerCase();
}

export interface FareRules {
  tiers: MlmFareTier[];
  /** Edges that count as 2 stations (official sea-crossing note). */
  seaCrossingPairs: readonly [string, string][];
  /** Stations counted only as journey endpoints (e.g. 協和醫院). */
  endpointOnlyStations: readonly string[];
}

/**
 * Station-count fare with official counting rules:
 * sea-crossing edges count as 2 stations; endpoint-only stations are not
 * counted when passed through.
 */
export function stationCountFare(
  pathZh: string[],
  rules: FareRules,
  prefer: 'single' | 'card' | 'concessionSingle' | 'studentCard' = 'single'
): number | null {
  if (pathZh.length < 2) return null;
  const start = pathZh[0]!;
  const end = pathZh[pathZh.length - 1]!;
  let count = 0;
  for (let i = 0; i < pathZh.length - 1; i++) {
    const a = pathZh[i]!;
    const b = pathZh[i + 1]!;
    count += 1;
    const isSea = rules.seaCrossingPairs.some(
      ([x, y]) =>
        (foldStationName(x) === foldStationName(a) && foldStationName(y) === foldStationName(b)) ||
        (foldStationName(x) === foldStationName(b) && foldStationName(y) === foldStationName(a))
    );
    if (isSea) count += 1;
  }
  // Endpoint-only stations are not counted when passed through.
  for (const name of rules.endpointOnlyStations) {
    const fold = foldStationName(name);
    const isEndpoint = foldStationName(start) === fold || foldStationName(end) === fold;
    if (isEndpoint) continue;
    const onPath = pathZh.filter((n) => foldStationName(n) === fold).length;
    if (onPath > 0) count -= onPath;
  }
  if (count <= 0) return null;
  for (const tier of rules.tiers) {
    if (count <= tier.maxStations) return tier[prefer];
  }
  return rules.tiers[rules.tiers.length - 1]![prefer];
}

export function buildFareMatrix(opts: {
  stationIds: string[];
  /** station id → official Chinese name. */
  zhByStationId: Map<string, string>;
  /** Official line station orders (Chinese). */
  lineStations: { line: string; stations: string[] }[];
  rules: FareRules;
}): FareMatrixEncoded {
  const { stationIds, zhByStationId, lineStations, rules } = opts;
  const adj = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const { stations } of lineStations) {
    for (let i = 0; i < stations.length - 1; i++) addEdge(stations[i]!, stations[i + 1]!);
  }

  const shortestPath = (from: string, to: string): string[] | null => {
    if (from === to) return [from];
    const prev = new Map<string, string>();
    const q: string[] = [from];
    const seen = new Set([from]);
    while (q.length) {
      const cur = q.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        prev.set(nxt, cur);
        if (nxt === to) {
          const path = [to];
          let p = to;
          while (prev.has(p)) {
            p = prev.get(p)!;
            path.unshift(p);
          }
          return path;
        }
        q.push(nxt);
      }
    }
    return null;
  };

  const n = stationIds.length;
  const fares: (number | null)[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null)
  );
  for (let i = 0; i < n; i++) {
    fares[i]![i] = 0;
    for (let j = i + 1; j < n; j++) {
      const a = zhByStationId.get(stationIds[i]!);
      const b = zhByStationId.get(stationIds[j]!);
      if (!a || !b) continue;
      const path = shortestPath(a, b);
      const fare = path ? stationCountFare(path, rules, 'single') : null;
      fares[i]![j] = fare;
      fares[j]![i] = fare;
    }
  }

  return {
    $schema: 'https://schemas.openmetro.dev/v1/fares.schema.json',
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: 'MLM fare rules (station-count tiers)',
        url: 'https://www.mlm.com.mo/tc/general_ticket.html',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '澳門輕軌股份有限公司 (Macao Light Rapid Transit Corporation, Limited)',
        notes:
          'Fares are a function of station count (sea-crossing = 2 stations; endpoint-only stations not counted when passed through).'
      }
    ],
    currency: 'MOP',
    unit: 'pataca',
    station_ids: stationIds,
    fares
  };
}
