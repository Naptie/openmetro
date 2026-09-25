import {
  mapPool,
  type PatternEncoded,
  type SegmentEncoded,
  type StopEncoded
} from '@openmetro/core';
import { fetchPrice } from './fetch.js';

export const ZZ_SEGMENT_SOURCE = 'zzmetro-api-price';

export interface ZzSegmentMetric {
  from_stop_id: string;
  to_stop_id: string;
  travel_time_seconds?: number;
  distance_km?: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Harvest official segment run times + path distances from `/api/price`
 * for every adjacent stop pair (one planner query per undirected edge).
 */
export async function collectZhengzhouSegmentMetrics(opts: {
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  /** Planner-side station key (official zid) per stop id. */
  zidOf: (stopId: string) => string | undefined;
  concurrency?: number;
  delayMs?: number;
}): Promise<{ segments: ZzSegmentMetric[]; fetched: number; failed: number }> {
  const stopById = new Map(opts.stops.map((s) => [s.id, s] as const));
  const pairs = new Map<string, { from: string; to: string }>();
  for (const p of opts.patterns) {
    const ids = p.stop_ids;
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i];
      const b = ids[i + 1];
      if (!a || !b) continue;
      pairs.set(pairKey(a, b), { from: a, to: b });
    }
    // Loop closing edge: last → first when both share the line and differ.
    const extras = p.extras as { loop?: boolean } | undefined;
    if (extras?.loop && ids.length > 2) {
      const a = ids[ids.length - 1];
      const b = ids[0];
      if (a && b && a !== b) pairs.set(pairKey(a, b), { from: a, to: b });
    }
  }

  const list = [...pairs.values()].filter(
    (p) => stopById.has(p.from) && stopById.has(p.to) && opts.zidOf(p.from) && opts.zidOf(p.to)
  );
  console.log(`  harvest ${list.length} adjacent pairs via /api/price`);

  const out: ZzSegmentMetric[] = [];
  let failed = 0;
  const results = await mapPool(
    list,
    async (pair) => {
      const za = opts.zidOf(pair.from);
      const zb = opts.zidOf(pair.to);
      if (!za || !zb) return null;
      const data = await fetchPrice(za, zb, 'distance');
      if (!data) {
        failed++;
        return null;
      }
      const time = Number(data.time);
      const dist = Number(data.distance);
      return {
        from_stop_id: pair.from,
        to_stop_id: pair.to,
        travel_time_seconds: Number.isFinite(time) && time > 0 ? Math.round(time) : undefined,
        distance_km: Number.isFinite(dist) && dist > 0 ? Math.round(dist * 1000) / 1000 : undefined
      } satisfies ZzSegmentMetric;
    },
    { concurrency: opts.concurrency ?? 6, delayMs: opts.delayMs ?? 50 }
  );
  for (const r of results) if (r) out.push(r);
  return { segments: out, fetched: out.length, failed };
}

/** Overwrite non-source segments with official planner times + distances. */
export function applyZhengzhouSegmentMetrics(
  segments: SegmentEncoded[],
  metrics: ZzSegmentMetric[]
): { segments: SegmentEncoded[]; applied: number } {
  const byPair = new Map<string, ZzSegmentMetric>();
  for (const m of metrics) {
    if (!(m.travel_time_seconds && m.travel_time_seconds > 0)) continue;
    const key = pairKey(m.from_stop_id, m.to_stop_id);
    if (!byPair.has(key)) byPair.set(key, m);
  }
  let applied = 0;
  const out = segments.map((s) => {
    const hit = byPair.get(pairKey(s.from_stop_id, s.to_stop_id));
    if (!hit) return s;
    if (
      s.travel_time_source === 'source' &&
      s.travel_time_seconds === hit.travel_time_seconds &&
      s.distance_km === hit.distance_km
    ) {
      return s;
    }
    applied++;
    return {
      ...s,
      travel_time_seconds: hit.travel_time_seconds ?? s.travel_time_seconds,
      // Official planner hop time — counted as source precision (like Suzhou).
      travel_time_source: 'source' as const,
      travel_time_derived_from: undefined,
      distance_km: hit.distance_km ?? s.distance_km,
      source_id: ZZ_SEGMENT_SOURCE,
      extras: {
        ...(s.extras ?? {}),
        planner: 'zzmetro-api-price',
        // Replace any earlier haversine tag so quality counts this as official.
        distance_source:
          hit.distance_km != null
            ? 'source'
            : (s.extras as { distance_source?: string } | undefined)?.distance_source
      }
    };
  });
  return { segments: out, applied };
}
