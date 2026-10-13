/**
 * Fares for cn-tianjin.
 *
 * Tianjin prices by **riding interval count** (乘坐区间数), not mileage — the
 * published tariff (天津市轨道交通票价) is:
 *
 * - ≤4 区间: 2 yuan; 5–9 区间: 3 yuan; 10–15 区间: 4 yuan; ≥16 区间: 5 yuan
 *   (the metro network is capped at 5 yuan).
 * - Lines 1–11, Z4, 津静线 and the 9号线 urban section (天津站—中山门) share
 *   that ladder; every ride interval counts, transfers at a station are free.
 * - The 9号线 coastal section (滨海段, 中山门—东海路) keeps its own per-station
 *   fare table (津滨轻轨), which is not monotone in distance (泰达 quotes
 *   higher than the further 新立→东海路 pair) — so coastal ODs are **harvested
 *   live from the Baidu Direction planner**, which mirrors the operator's
 *   table (verified 2026-10: 中山门→东海路 6, 天津站→东海路 9).
 * - Journeys spanning both zones add the network fare (counted to 中山门) and
 *   the coastal fare (from 中山门): 营口道→东海路 = 3 + 6 = 9 ✓,
 *   刘园→东海路 = 5 + 6 = 11 ✓, 曹庄→东海路 = 4 + 6 = 10 ✓.
 *
 * So the matrix is computed deterministically from the interval ladder for
 * network ODs and quoted per-pair for the 120 coastal ODs (+15 anchor rows),
 * with boundary and cross-zone sanity quotes logged loudly on drift.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterCacheDir,
  BaiduPlannerClient,
  entitySchemaUrl,
  loadBaiduGapfillConfig
} from '@openmetro/core';

const NETWORK_ID = 'cn-tianjin';

/** Official Tianjin interval tariff (乘坐区间数 → yuan). */
export const INTERVAL_TARIFF = {
  steps: [
    { upToIntervals: 4, yuan: 2 },
    { upToIntervals: 9, yuan: 3 },
    { upToIntervals: 15, yuan: 4 }
  ],
  beyond: 5
} as const;

export function intervalFare(intervals: number): number {
  // 0 intervals (the OD's network leg starts at the 中山门 anchor itself)
  // contributes no network fare.
  if (!Number.isFinite(intervals) || intervals <= 0) return 0;
  for (const step of INTERVAL_TARIFF.steps) {
    if (intervals <= step.upToIntervals) return step.yuan;
  }
  return INTERVAL_TARIFF.beyond;
}

/** The 9号线 boundary station between the metro network and the coastal table. */
const ZHONGSHANMEN = '中山门';

interface FareQuoteCache {
  harvestedAt: string;
  /** `中山门 → coastal station` anchor prices (yuan). */
  anchors: Record<string, number>;
  /** `coastalA|coastalB` (sorted) → price (yuan). */
  coastal: Record<string, number>;
}

interface StationRow {
  id: string;
  name: string;
  location?: { lon: number; lat: number; crs?: string };
}

interface PatternRow {
  id: string;
  line_id: string;
  is_primary: boolean;
  stop_ids: string[];
  extras?: { alignment?: string };
}

interface StopRow {
  id: string;
  station_id: string;
  line_id: string;
}

async function loadQuoteCache(): Promise<FareQuoteCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(adapterCacheDir(NETWORK_ID), 'fare-quotes.json'), 'utf-8')
    ) as FareQuoteCache;
    if (raw && typeof raw.anchors === 'object' && typeof raw.coastal === 'object') return raw;
  } catch {
    // first run
  }
  return { harvestedAt: new Date().toISOString(), anchors: {}, coastal: {} };
}

/** Min-interval path counts (BFS over ride edges with free same-station transfers). */
function buildIntervalGraph(
  stations: StationRow[],
  stops: StopRow[],
  patterns: PatternRow[],
  transfers: { from_stop_id?: string; to_stop_id?: string }[],
  coastalStopIds: Set<string>
) {
  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;
  const stationOfStop = new Map(stops.map((s) => [s.id, s.station_id] as const));
  const adj: { to: number; intervals: number }[][] = Array.from({ length: n }, () => []);

  const addEdge = (a: string, b: string, intervals: number) => {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null || i === j) return;
    adj[i]!.push({ to: j, intervals });
    adj[j]!.push({ to: i, intervals });
  };

  for (const pattern of patterns) {
    const ids9 = pattern.stop_ids;
    for (let i = 0; i + 1 < ids9.length; i++) {
      const sa = stationOfStop.get(ids9[i]!);
      const sb = stationOfStop.get(ids9[i + 1]!);
      if (!sa || !sb) continue;
      // Coastal ride edges never participate in interval pricing: coastal ODs
      // come from the harvested table, cross-zone fares anchor at 中山门.
      if (coastalStopIds.has(ids9[i]!) && coastalStopIds.has(ids9[i + 1]!)) continue;
      addEdge(sa, sb, 1);
    }
  }
  for (const t of transfers) {
    const sa = stationOfStop.get(t.from_stop_id ?? '');
    const sb = stationOfStop.get(t.to_stop_id ?? '');
    if (!sa || !sb) continue;
    addEdge(sa, sb, 0);
  }
  return { ids, idx, adj, n };
}

function minIntervalsFrom(
  source: number,
  n: number,
  adj: { to: number; intervals: number }[][]
): number[] {
  const dist = Array.from({ length: n }, () => Number.POSITIVE_INFINITY);
  dist[source] = 0;
  // 0/1-weight Dijkstra via deque-free priority scan is fine at this size.
  const queue: [number, number][] = [[0, source]];
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i]![0] < queue[best]![0]) best = i;
    }
    const [d, u] = queue.splice(best, 1)[0]!;
    if (d > dist[u]!) continue;
    for (const e of adj[u]!) {
      const nd = d + e.intervals;
      if (nd < dist[e.to]!) {
        dist[e.to] = nd;
        queue.push([nd, e.to]);
      }
    }
  }
  return dist;
}

interface BaiduQuote {
  price?: number;
}

async function quoteBaidu(
  client: BaiduPlannerClient,
  origin: { lon: number; lat: number },
  dest: { lon: number; lat: number }
): Promise<number | null> {
  const body = (
    await client.transit({ lat: origin.lat, lng: origin.lon }, { lat: dest.lat, lng: dest.lon })
  )?.result?.routes;
  const routes = body ?? [];
  for (const route of routes) {
    const steps = route.steps?.flat?.() ?? route.steps ?? [];
    // Only metro routes count: a bus alternative quotes a different fare.
    const hasMetro = (steps as { vehicle_info?: { detail?: { type?: number } } }[]).some(
      (s) => s.vehicle_info?.detail?.type === 1
    );
    if (!hasMetro) continue;
    const price = (route as BaiduQuote).price;
    if (typeof price === 'number' && price > 0) return price;
  }
  return null;
}

/**
 * Compute and write the OD fare matrix. Network ODs use the official interval
 * ladder; coastal-involving ODs use Baidu planner quotes (cached under
 * `tmp/cache/cn-tianjin/fare-quotes.json`); boundary and cross-zone sanity
 * quotes validate the rules against the planner on every run.
 */
export async function computeAndWriteFares(dataDir: string, ak: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const stops = (
    JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')).records as StopRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const patterns = (
    JSON.parse(await readFile(join(dataDir, 'patterns.json'), 'utf-8')).records as PatternRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const transfers = (JSON.parse(await readFile(join(dataDir, 'transfers.json'), 'utf-8')).records ??
    []) as { from_stop_id?: string; to_stop_id?: string }[];

  const line9Primary = patterns.find((p) => p.extras?.alignment === '9号线' && p.is_primary);
  if (!line9Primary) throw new Error('fares: line 9 primary pattern not found');
  const stationOfStop = new Map(stops.map((s) => [s.id, s.station_id] as const));
  const anchorIdx = line9Primary.stop_ids.findIndex(
    (id) => stations.find((s) => s.id === stationOfStop.get(id))?.name === ZHONGSHANMEN
  );
  if (anchorIdx < 0) throw new Error('fares: 中山门 not on the line 9 primary pattern');
  const coastalStops = line9Primary.stop_ids.slice(0, anchorIdx);
  const coastalStationIds = new Set(
    coastalStops.map((id) => stationOfStop.get(id)).filter((x): x is string => !!x)
  );

  const { ids, idx, adj, n } = buildIntervalGraph(
    stations,
    stops,
    patterns,
    transfers,
    coastalStationIds
  );
  const stationName = new Map(stations.map((s) => [s.id, s.name] as const));
  const locOf = new Map(
    stations
      .filter((s) => s.location)
      .map((s) => [s.id, { lon: s.location!.lon, lat: s.location!.lat }] as const)
  );

  const zhongshanmenId = ids.find((id) => stationName.get(id) === ZHONGSHANMEN);
  if (!zhongshanmenId) throw new Error('fares: 中山门 station missing');

  // Min-interval counts from every network station (coastal stations excluded
  // as origins; their cross-zone fare anchors at 中山门).
  const networkIdx: number[] = [];
  for (let i = 0; i < n; i++) if (!coastalStationIds.has(ids[i]!)) networkIdx.push(i);
  const intervalsFrom = new Map<number, number[]>();
  for (const i of networkIdx) intervalsFrom.set(i, minIntervalsFrom(i, n, adj));

  // ---------------------------------------------------------------------------
  // Harvest coastal prices (anchors + coastal×coastal), cached.
  // ---------------------------------------------------------------------------
  const cfg = loadBaiduGapfillConfig({ OPENMETRO_BAIDU_AK: ak });
  if ('error' in cfg) throw new Error(`fares: ${cfg.error}`);
  const client = new BaiduPlannerClient({ ...cfg, qps: 2 });
  const cache = await loadQuoteCache();

  const coastalIds = ids.filter((id) => coastalStationIds.has(id));
  const zhongshanmenIdx = idx.get(zhongshanmenId)!;
  let freshQuotes = 0;

  const quote = async (aId: string, bId: string): Promise<number | null> => {
    const a = locOf.get(aId);
    const b = locOf.get(bId);
    if (!a || !b) return null;
    return quoteBaidu(client, a, b);
  };

  for (const cId of coastalIds) {
    const cName = stationName.get(cId)!;
    if (cache.anchors[cName] != null) continue;
    const price = await quote(zhongshanmenId, cId).catch(() => null);
    if (price != null) {
      cache.anchors[cName] = price;
      freshQuotes++;
    } else {
      console.log(`  WARN: no coastal anchor quote 中山门→${cName}`);
    }
  }
  for (let i = 0; i < coastalIds.length; i++) {
    for (let j = i + 1; j < coastalIds.length; j++) {
      const a = coastalIds[i]!;
      const b = coastalIds[j]!;
      const key = [a, b].sort().join('|');
      if (cache.coastal[key] != null) continue;
      const price = await quote(a, b).catch(() => null);
      if (price != null) {
        cache.coastal[key] = price;
        freshQuotes++;
      } else {
        console.log(`  WARN: no coastal quote ${stationName.get(a)}→${stationName.get(b)}`);
      }
    }
  }
  cache.harvestedAt = new Date().toISOString();
  await mkdir(adapterCacheDir(NETWORK_ID), { recursive: true });
  await writeFile(
    join(adapterCacheDir(NETWORK_ID), 'fare-quotes.json'),
    `${JSON.stringify(cache, null, 2)}\n`,
    'utf-8'
  );
  console.log(
    `  coastal quotes: ${freshQuotes} fresh, ${coastalIds.length} anchors, ${
      (coastalIds.length * (coastalIds.length - 1)) / 2
    } pairs`
  );

  // ---------------------------------------------------------------------------
  // Sanity quotes: ladder boundaries + cross-zone rule.
  // ---------------------------------------------------------------------------
  const networkAnchorPairs: [string, string][] = [
    ['刘园', '勤俭道'], // 4 区间 → 2
    ['刘园', '洪湖里'], // 5 区间 → 3
    ['水上公园西路', '文化中心'], // 5 区间 → 3
    ['水上公园西路', '东丽六经路'], // 20 区间 → 5
    ['于台', '柳林路'], // 11 区间 → 4
    ['南孙庄', '渌水道'], // 39 区间 → 5 (cap)
    ['东沽路', '天津站'], // 18 区间 → 5
    ['天津站', '中山门'] // 5 区间 → 3
  ];
  let ladderChecks = 0;
  let ladderBad = 0;
  for (const [aName, bName] of networkAnchorPairs) {
    const a = ids.find((id) => stationName.get(id) === aName);
    const b = ids.find((id) => stationName.get(id) === bName);
    if (a == null || b == null) continue;
    const ai = idx.get(a)!;
    const bi = idx.get(b)!;
    const dist = intervalsFrom.get(ai)?.[bi];
    if (dist == null || !Number.isFinite(dist)) continue;
    const expect = intervalFare(dist);
    const got = await quote(a, b).catch(() => null);
    ladderChecks++;
    if (got != null && got !== expect) {
      ladderBad++;
      console.log(
        `  ERROR: ladder drift ${aName}→${bName}: ${dist} intervals expected ${expect} yuan, planner quotes ${got}`
      );
    }
  }
  console.log(`  ladder sanity: ${ladderChecks - ladderBad}/${ladderChecks} match`);

  const crossPairs: [string, string][] = [
    ['天津站', '东海路'],
    ['营口道', '东海路'],
    ['刘园', '东海路'],
    ['曹庄', '东海路'],
    ['小淀', '东海路'],
    ['水上公园西路', '东海路'],
    ['直沽', '东海路'],
    ['会展中心', '天津站'],
    ['于台', '泰达'],
    ['团泊医学园', '东海路']
  ];
  let crossChecks = 0;
  let crossBad = 0;
  const mixedFare = (netId: string, coastalId: string): number | null => {
    const netIdx = idx.get(netId)!;
    const dist = intervalsFrom.get(netIdx)?.[zhongshanmenIdx];
    if (dist == null || !Number.isFinite(dist)) return null;
    const anchor = cache.anchors[stationName.get(coastalId) ?? ''];
    if (anchor == null) return null;
    return intervalFare(dist) + anchor;
  };
  for (const [aName, bName] of crossPairs) {
    const a = ids.find((id) => stationName.get(id) === aName);
    const b = ids.find((id) => stationName.get(id) === bName);
    if (a == null || b == null) continue;
    const aCoastal = coastalStationIds.has(a);
    const bCoastal = coastalStationIds.has(b);
    if (aCoastal === bCoastal) continue;
    const netId = aCoastal ? b : a;
    const coastalId = aCoastal ? a : b;
    const expect = mixedFare(netId, coastalId);
    if (expect == null) continue;
    const got = await quote(a, b).catch(() => null);
    crossChecks++;
    if (got != null && got !== expect) {
      crossBad++;
      console.log(
        `  ERROR: cross-zone drift ${aName}→${bName}: expected ${expect} yuan (network+coastal), planner quotes ${got}`
      );
    }
  }
  console.log(`  cross-zone sanity: ${crossChecks - crossBad}/${crossChecks} match`);
  if (crossBad > crossChecks / 2) {
    throw new Error(
      'fares: cross-zone pricing model disagrees with planner quotes — re-verify the tariff'
    );
  }

  // ---------------------------------------------------------------------------
  // Assemble the symmetric matrix.
  // ---------------------------------------------------------------------------
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );
  let nullRows = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aId = ids[i]!;
      const bId = ids[j]!;
      const aCoastal = coastalStationIds.has(aId);
      const bCoastal = coastalStationIds.has(bId);
      let fare: number | null = null;
      if (!aCoastal && !bCoastal) {
        const dist = intervalsFrom.get(i)?.[j];
        if (dist != null && Number.isFinite(dist)) fare = intervalFare(dist);
      } else if (aCoastal && bCoastal) {
        fare = cache.coastal[[aId, bId].sort().join('|')] ?? null;
      } else {
        fare = mixedFare(aCoastal ? bId : aId, aCoastal ? aId : bId);
      }
      if (fare != null) {
        matrix[i]![j] = fare;
        matrix[j]![i] = fare;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (matrix[i]!.every((v, j) => v == null && j !== i)) nullRows++;
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '天津市轨道交通票价（乘坐区间数计价）+ 津滨轻轨滨海段站点票价表（Baidu Direction 逐对报价）',
        url: 'https://www.tjgdjt.com/',
        version: '2026-10',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '天津轨道交通集团有限公司',
        notes:
          '网络票价按官方区间阶梯计算（≤4区间2元、5-9区间3元、10-15区间4元、≥16区间5元封顶），计费区间数取线网最少区间路径（同站换乘不计区间）；9号线滨海段（中山门—东海路）为津滨轻轨站点票价表（对距离非单调），逐对收割百度路径规划报价；跨段乘距 = 网络段票价（计至中山门）+ 滨海段票价。边界与跨段规则每次同步用规划器报价抽样校验。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: ids,
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote fares.json (${n}x${n}, ${nullRows} null rows)`);
}
