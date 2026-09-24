import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchTravel } from './fetch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OfficialDistanceCache {
  /** `${fromStationId}|${toStationId}` → path meters from getTravel.dis */
  meters: Record<string, number>;
}

/**
 * Harvest official planner path length (`getTravel.dis`, meters) for every
 * undirected adjacent station pair. This is the only source that reports true
 * network path length — fare bands are too coarse to invert.
 */
export async function harvestOfficialSegmentDistances(
  dataDir: string,
  opts: { concurrency?: number; delayMs?: number } = {}
): Promise<OfficialDistanceCache> {
  const concurrency = opts.concurrency ?? 2;
  const delayMs = opts.delayMs ?? 400;

  const stations = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as {
    id: string;
    name: string;
  }[];
  const nameOf = new Map(stations.map((s) => [s.id, s.name] as const));
  const segs = JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
    from_station_id: string;
    to_station_id: string;
    distance_km?: number;
  }[];

  const cachePath = join(dataDir, 'official-distances.json');
  let cache: OfficialDistanceCache = { meters: {} };
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf-8')) as OfficialDistanceCache;
  } catch {
    cache = { meters: {} };
  }

  // Unique undirected adjacent pairs (one query per edge is enough).
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    const a = s.from_station_id;
    const b = s.to_station_id;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push(a < b ? [a, b] : [b, a]);
  }

  const todo = pairs.filter(([a, b]) => {
    const k = `${a}|${b}`;
    return cache.meters[k] == null && nameOf.has(a) && nameOf.has(b);
  });
  console.log(
    `  official distances: ${pairs.length} edges, ${todo.length} to fetch (cached ${
      pairs.length - todo.length
    })`
  );

  let next = 0;
  let ok = 0;
  let fail = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= todo.length) return;
      const [a, b] = todo[i]!;
      const ka = `${a}|${b}`;
      const kb = `${b}|${a}`;
      try {
        const plans = await fetchTravel(nameOf.get(a)!, nameOf.get(b)!, 2);
        const meters = Number(plans[0]?.dis);
        if (Number.isFinite(meters) && meters > 0) {
          cache.meters[ka] = meters;
          cache.meters[kb] = meters;
          ok++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
      if (delayMs > 0) await sleep(delayMs);
      if ((ok + fail) % 50 === 0) {
        console.log(`  official distances: ${ok + fail}/${todo.length} (ok ${ok}, fail ${fail})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()));
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
  console.log(`  official distances: ok ${ok}, fail ${fail}, cache ${cachePath}`);
  return cache;
}

/**
 * Write official planner path lengths onto `segments.json` as `distance_km`.
 * Keeps haversine as fallback when the planner has no value for an edge.
 */
export async function applyOfficialSegmentDistances(
  dataDir: string,
  cache: OfficialDistanceCache
): Promise<{ updated: number; kept: number }> {
  const segsPath = join(dataDir, 'segments.json');
  const doc = JSON.parse(await readFile(segsPath, 'utf-8')) as {
    records: {
      id: string;
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  let updated = 0;
  let kept = 0;
  for (const s of doc.records) {
    const meters = cache.meters[`${s.from_station_id}|${s.to_station_id}`];
    if (meters != null && meters > 0) {
      s.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      s.extras = {
        ...(s.extras ?? {}),
        distance_source: 'getTravel_dis',
        distance_meters: meters
      };
      updated++;
    } else {
      kept++;
    }
  }
  await writeFile(segsPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  console.log(`  segments: official distance on ${updated}, kept prior ${kept}`);
  return { updated, kept };
}

/**
 * Recover missing edges around a junction the planner cannot use as an OD
 * endpoint (e.g. 新业路). Through-path `dis` between its neighbours gives
 *   dis(A,B) = d(A,X) + d(X,B)
 * and the 3-neighbour triangle solves each edge. Long-path residuals
 * (neighbour → far station via X) independently confirm the pair sums.
 */
export async function triangulateJunctionEdges(
  dataDir: string,
  junctionStationId: string,
  /** neighbour id → through-path meters to the other two neighbours */
  pairMeters: Record<string, number>
): Promise<void> {
  // pairMeters keys like "neighA|neighB"
  const entries = Object.entries(pairMeters);
  const nodes = new Set<string>();
  for (const [k] of entries) {
    const [a, b] = k.split('|');
    nodes.add(a!);
    nodes.add(b!);
  }
  if (nodes.size !== 3) throw new Error('triangulateJunctionEdges expects a 3-neighbour triangle');
  const [a, b, c] = [...nodes];
  const ab = pairMeters[`${a}|${b}`] ?? pairMeters[`${b}|${a}`];
  const ac = pairMeters[`${a}|${c}`] ?? pairMeters[`${c}|${a}`];
  const bc = pairMeters[`${b}|${c}`] ?? pairMeters[`${c}|${b}`];
  if (ab == null || ac == null || bc == null) throw new Error('triangle missing a pair total');
  const dA = (ab + ac - bc) / 2;
  const dB = (ab + bc - ac) / 2;
  const dC = (ac + bc - ab) / 2;
  const solved: Record<string, number> = {
    [a!]: dA,
    [b!]: dB,
    [c!]: dC
  };

  const segsPath = join(dataDir, 'segments.json');
  const doc = JSON.parse(await readFile(segsPath, 'utf-8')) as {
    records: {
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  for (const s of doc.records) {
    let other: string | null = null;
    if (s.from_station_id === junctionStationId) other = s.to_station_id;
    else if (s.to_station_id === junctionStationId) other = s.from_station_id;
    if (!other || solved[other] == null) continue;
    const meters = solved[other];
    s.distance_km = Math.round(meters) / 1000;
    s.extras = {
      ...(s.extras ?? {}),
      distance_source: 'getTravel_dis_triangulation',
      distance_meters: Math.round(meters),
      distance_method: 'triangle through junction: dis(A,B)=d(A,X)+d(X,B)'
    };
  }
  await writeFile(segsPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');

  const cachePath = join(dataDir, 'official-distances.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf-8')) as OfficialDistanceCache & {
    inferred?: Record<string, unknown>;
  };
  for (const [nei, meters] of Object.entries(solved)) {
    cache.meters[`${junctionStationId}|${nei}`] = Math.round(meters);
    cache.meters[`${nei}|${junctionStationId}`] = Math.round(meters);
  }
  cache.inferred = {
    ...(cache.inferred ?? {}),
    [junctionStationId]: {
      method: 'triangle_through_junction',
      edges_m: solved,
      inputs_m: pairMeters
    }
  };
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
  console.log(
    `  triangulated ${nodes.size} edges at ${junctionStationId}: ` +
      [...nodes].map((n) => `${n}=${solved[n]}`).join(', ')
  );
}
