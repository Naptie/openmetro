import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chengduMileageFare } from './fares.js';

export interface FillFaresResult {
  totalNulls: number;
  byNeighbor: number;
  byFormula: number;
  remaining: number;
}

/**
 * Fill unpublished OD fares:
 *   1) neighbor official-price mode (1-station hop rarely changes the fare);
 *   2) mileage formula on the sum of official planner path lengths.
 *
 * Official harvested prices are never overwritten.
 */
export async function fillFareGaps(dataDir: string): Promise<FillFaresResult> {
  const stations = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as {
    id: string;
    name: string;
  }[];
  const nameOf = new Map(stations.map((s) => [s.id, s.name] as const));
  const faresPath = join(dataDir, 'fares.json');
  const faresDoc = JSON.parse(await readFile(faresPath, 'utf-8')) as {
    station_ids: string[];
    fares: (number | null)[][];
    source: Record<string, unknown>[];
    generated_at: string;
  };
  const segs = JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
    from_station_id: string;
    to_station_id: string;
    distance_km?: number;
    extras?: { distance_source?: string };
  }[];

  const ids = faresDoc.station_ids;
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const F = faresDoc.fares;

  // Station graph with official path lengths (km).
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number) => {
    if (!adj.has(a)) adj.set(a, new Map());
    const cur = adj.get(a)!.get(b);
    if (cur == null || w < cur) adj.get(a)!.set(b, w);
  };
  for (const s of segs) {
    const w = s.distance_km ?? 1;
    link(s.from_station_id, s.to_station_id, w);
    link(s.to_station_id, s.from_station_id, w);
  }

  function pathKm(a: string, b: string): number | null {
    if (a === b) return 0;
    const dist = new Map<string, number>();
    const done = new Set<string>();
    dist.set(a, 0);
    for (;;) {
      let u: string | null = null;
      let best = Infinity;
      for (const [k, v] of dist) {
        if (!done.has(k) && v < best) {
          best = v;
          u = k;
        }
      }
      if (u == null) break;
      if (u === b) return best;
      done.add(u);
      for (const [v, w] of adj.get(u) ?? []) {
        const nd = best + w;
        if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd);
      }
    }
    return null;
  }

  function neighborMode(i: number, j: number): number | null {
    const a = ids[i]!;
    const b = ids[j]!;
    const votes: number[] = [];
    for (const n of adj.get(a)?.keys() ?? []) {
      const ni = idx.get(n);
      // Skip the destination itself: F[j][j] is the 0 diagonal, not a fare.
      if (ni == null || ni === j) continue;
      const v = F[ni]?.[j] ?? F[j]?.[ni];
      if (v != null && v > 0) votes.push(v);
    }
    for (const n of adj.get(b)?.keys() ?? []) {
      const nj = idx.get(n);
      if (nj == null || nj === i) continue;
      const v = F[i]?.[nj] ?? F[nj]?.[i];
      if (v != null && v > 0) votes.push(v);
    }
    if (!votes.length) return null;
    const cnt = new Map<number, number>();
    for (const v of votes) cnt.set(v, (cnt.get(v) ?? 0) + 1);
    // Mode; ties break to the higher fare (never under-quote).
    let best = votes[0]!;
    let bestN = -1;
    for (const [v, n] of [...cnt.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])) {
      best = v;
      bestN = n;
      break;
    }
    void bestN;
    return best;
  }

  let totalNulls = 0;
  let byNeighbor = 0;
  let byFormula = 0;
  let remaining = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (F[i]![j] != null) continue;
      totalNulls++;
      const viaN = neighborMode(i, j);
      if (viaN != null) {
        F[i]![j] = viaN;
        F[j]![i] = viaN;
        byNeighbor++;
        continue;
      }
      const km = pathKm(ids[i]!, ids[j]!);
      if (km != null && km > 0) {
        const p = chengduMileageFare(km);
        F[i]![j] = p;
        F[j]![i] = p;
        byFormula++;
      } else {
        remaining++;
      }
    }
  }

  const officialN = segs.filter((s) => s.extras?.distance_source === 'getTravel_dis').length;
  faresDoc.source = [
    ...faresDoc.source,
    {
      name: 'Chengdu fare gap fill (neighbor mode + mileage formula on official path km)',
      url: 'https://www.chengdurail.com/system/resource/cddt/getTravel.jsp',
      version: '2026-gapfill',
      retrieved_at: new Date().toISOString(),
      license: 'unknown',
      license_url: null,
      attribution: '成都轨道交通集团有限公司',
      notes: `Derived fills for unpublished OD pairs. Neighbor official-price mode first; else chengduMileageFare on Dijkstra path of getTravel.dis segment distances (${officialN} official edges). Filled neighbor=${byNeighbor}, formula=${byFormula}, remaining=${remaining}, from_null=${totalNulls}. Official harvested prices untouched.`
    }
  ];
  faresDoc.generated_at = new Date().toISOString();
  await writeFile(faresPath, `${JSON.stringify(faresDoc, null, 2)}\n`, 'utf-8');
  void nameOf;
  console.log(
    `  fare gaps: nulls=${totalNulls} neighbor=${byNeighbor} formula=${byFormula} remaining=${remaining}`
  );
  return { totalNulls, byNeighbor, byFormula, remaining };
}
