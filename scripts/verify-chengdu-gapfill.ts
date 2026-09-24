/**
 * Hold-out validation: neighbor official-price mode + mileage formula on
 * official getTravel.dis path km. Masks a sample of known fares and scores
 * reconstruction — the same pipeline used for published gap fills.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chengduMileageFare } from '../packages/adapters/cn-chengdu/src/fares.js';

const tmp = 'data/cn-chengdu';
const stations = JSON.parse(readFileSync(join(tmp, 'stations.json'), 'utf-8')).records as {
  id: string;
  name: string;
}[];
const faresDoc = JSON.parse(readFileSync(join(tmp, 'fares.json'), 'utf-8')) as {
  station_ids: string[];
  fares: (number | null)[][];
};
const segs = JSON.parse(readFileSync(join(tmp, 'segments.json'), 'utf-8')).records as {
  from_station_id: string;
  to_station_id: string;
  distance_km?: number;
}[];

const ids = faresDoc.station_ids;
const idx = new Map(ids.map((id, i) => [id, i] as const));
const nameOf = new Map(stations.map((s) => [s.id, s.name] as const));

const adj = new Map<string, Map<string, number>>();
function link(a: string, b: string, w: number): void {
  if (!adj.has(a)) adj.set(a, new Map());
  const cur = adj.get(a)!.get(b);
  if (cur == null || w < cur) adj.get(a)!.set(b, w);
}
for (const s of segs) {
  link(s.from_station_id, s.to_station_id, s.distance_km ?? 1);
  link(s.to_station_id, s.from_station_id, s.distance_km ?? 1);
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

// Work on a copy so official cells stay intact
const work = Fmap(faresDoc.fares);
function Fmap(src: (number | null)[][]): (number | null)[][] {
  return src.map((row) => row.map((v) => v));
}

function neighborMode(i: number, j: number): number | null {
  const a = ids[i]!;
  const b = ids[j]!;
  const votes: number[] = [];
  for (const n of adj.get(a)?.keys() ?? []) {
    const ni = idx.get(n);
    if (ni == null || ni === j) continue;
    const v = work[ni]?.[j] ?? work[j]?.[ni];
    if (v != null && v > 0) votes.push(v);
  }
  for (const n of adj.get(b)?.keys() ?? []) {
    const nj = idx.get(n);
    if (nj == null || nj === i) continue;
    const v = work[i]?.[nj] ?? work[nj]?.[i];
    if (v != null && v > 0) votes.push(v);
  }
  if (!votes.length) return null;
  const cnt = new Map<number, number>();
  for (const v of votes) cnt.set(v, (cnt.get(v) ?? 0) + 1);
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

function predict(i: number, j: number): { price: number | null; how: string } {
  const n = neighborMode(i, j);
  if (n != null) return { price: n, how: 'neighbor' };
  const km = pathKm(ids[i]!, ids[j]!);
  if (km != null && km > 0) return { price: chengduMileageFare(km), how: 'formula' };
  return { price: null, how: 'none' };
}

// Sample hold-out from currently filled official+derived cells that were
// originally official (non-null in source[0] harvest). We approximate by
// holding out every 17th non-null pair.
const holdout: { i: number; j: number; trueF: number }[] = [];
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const v = work[i]![j];
    if (v == null) continue;
    if (holdout.length % 17 !== 0 && Math.random() > 0.08) {
      // keep a stable sample: every 17th
    }
    if ((i * 31 + j) % 17 === 0) holdout.push({ i, j, trueF: v });
  }
}

// mask holdout
for (const h of holdout) {
  work[h.i]![h.j] = null;
  work[h.j]![h.i] = null;
}

let n = 0;
let exact = 0;
let within1 = 0;
let within2 = 0;
const byN = { n: 0, e0: 0, e1: 0, e2: 0 };
const byF = { n: 0, e0: 0, e1: 0, e2: 0 };
const miss: string[] = [];

for (const h of holdout) {
  const { price, how } = predict(h.i, h.j);
  if (price == null) continue;
  n++;
  const d = Math.abs(price - h.trueF);
  if (d === 0) exact++;
  if (d <= 1) within1++;
  if (d <= 2) within2++;
  const bucket = how === 'neighbor' ? byN : byF;
  bucket.n++;
  if (d === 0) bucket.e0++;
  else if (d === 1) bucket.e1++;
  else {
    bucket.e2++;
    if (miss.length < 8) {
      miss.push(
        `${nameOf.get(ids[h.i]!)}->${nameOf.get(ids[h.j]!)} true=${h.trueF} pred=${price} via=${how}`
      );
    }
  }
}

console.log('=== hold-out: neighbor mode + formula(official path km) ===');
console.log(`sampled ${holdout.length}, predicted ${n}`);
console.log(
  `exact ${exact} (${((exact / n) * 100).toFixed(1)}%)  ` +
    `within1 ${within1} (${((within1 / n) * 100).toFixed(1)}%)  ` +
    `within2 ${within2} (${((within2 / n) * 100).toFixed(1)}%)`
);
if (byN.n) {
  console.log(
    `neighbor: n=${byN.n} exact=${((byN.e0 / byN.n) * 100).toFixed(1)}% ` +
      `±1=${(((byN.e0 + byN.e1) / byN.n) * 100).toFixed(1)}%`
  );
}
if (byF.n) {
  console.log(
    `formula:  n=${byF.n} exact=${((byF.e0 / byF.n) * 100).toFixed(1)}% ` +
      `±1=${(((byF.e0 + byF.e1) / byF.n) * 100).toFixed(1)}%`
  );
} else {
  console.log('formula:  n=0 (neighbor covered all holdouts)');
}
if (miss.length) {
  console.log('miss |d|>=2:');
  for (const s of miss) console.log(`  ${s}`);
}

// Official distance coverage + Xinye sample
const officialEdges = segs.filter((s) => s.extras?.distance_source === 'getTravel_dis').length;
const totalEdges = segs.length;
console.log('');
console.log(`official distance segments: ${officialEdges}/${totalEdges}`);
const xi = idx.get('cn-chengdu-xinye-road');
if (xi != null) {
  let filled = 0;
  for (let j = 0; j < ids.length; j++) {
    if (j !== xi && faresDoc.fares[xi]![j] != null) filled++;
  }
  console.log(`Xinye Road OD filled: ${filled}/388`);
}
