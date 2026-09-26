import { foldStationName } from '@openmetro/core';
import { fetchWuhanPathPhp, fetchWuhanRoute } from './fetch.js';

export interface PlannerSegmentTime {
  /** fold(from) + '|' + fold(to) on the same line (order-independent key built by caller). */
  fromName: string;
  toName: string;
  travel_time_seconds?: number;
  distance_km?: number;
  source: 'route' | 'pathphp';
}

export interface PlannerTransferTime {
  stationName: string;
  fromLineShort: string;
  toLineShort: string;
  walk_time_seconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Harvest official adjacent-station travel times (and optional OD distances)
 * from the site trip planner.
 */
export async function collectWuhanAdjacentTimes(
  pairs: { fromName: string; toName: string }[],
  opts: { delayMs?: number } = {}
): Promise<PlannerSegmentTime[]> {
  const delayMs = opts.delayMs ?? 80;
  const out: PlannerSegmentTime[] = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= pairs.length) return;
      const pair = pairs[i]!;
      try {
        const route = await fetchWuhanRoute(pair.fromName, pair.toName);
        const seg = route?.rtData?.buslist?.[0]?.segmentBoList?.[0];
        const minutes = num(seg?.duration);
        if (minutes != null && minutes > 0) {
          out.push({
            fromName: pair.fromName,
            toName: pair.toName,
            travel_time_seconds: Math.round(minutes * 60),
            source: 'route'
          });
        } else {
          // Fallback: path.php distance + time (includes dwell; still official).
          const php = await fetchWuhanPathPhp(pair.fromName, pair.toName);
          const path = php?.paths?.[0];
          const seconds = num(path?.time?.value);
          const km = num(path?.distance?.value);
          if (seconds != null && seconds > 0 && seconds < 20 * 60) {
            out.push({
              fromName: pair.fromName,
              toName: pair.toName,
              travel_time_seconds: Math.round(seconds),
              distance_km: km,
              source: 'pathphp'
            });
          }
        }
      } catch {
        // ignore individual failures
      }
      await sleep(delayMs);
    }
  }

  await Promise.all([worker(), worker()]);
  return out;
}

/**
 * Harvest official transfer walk times at interchanges by routing a short OD
 * that forces a transfer through the interchange, then reading `outDuration`.
 */
export async function collectWuhanTransferTimes(
  interchange: {
    stationName: string;
    fromLineShort: string;
    toLineShort: string;
    /** Neighbour station on from-line (approaching the interchange). */
    fromNeighbor: string;
    /** Neighbour station on to-line (leaving the interchange). */
    toNeighbor: string;
  }[],
  opts: { delayMs?: number } = {}
): Promise<PlannerTransferTime[]> {
  const delayMs = opts.delayMs ?? 100;
  const out: PlannerTransferTime[] = [];

  for (const item of interchange) {
    try {
      const route = await fetchWuhanRoute(item.fromNeighbor, item.toNeighbor);
      const paths = route?.rtData?.buslist ?? [];
      for (const path of paths) {
        const segs = path.segmentBoList ?? [];
        if (segs.length < 2) continue;
        for (let i = 1; i < segs.length; i++) {
          const seg = segs[i]!;
          const prev = segs[i - 1]!;
          const minutes = num(seg.outDuration);
          // Planner `outDuration` can include dwell/wait; keep only walk-plausible values.
          if (minutes == null || minutes < 1 || minutes > 8) continue;
          const junction = foldStationName(String(seg.startname ?? prev.endname ?? ''));
          if (junction !== foldStationName(item.stationName)) continue;
          const fromLine = String(prev.linecode ?? '').replace(/^0/, '');
          const toLine = String(seg.linecode ?? '').replace(/^0/, '');
          if (fromLine !== item.fromLineShort && item.fromLineShort !== fromLine) continue;
          if (toLine !== item.toLineShort && item.toLineShort !== toLine) continue;
          out.push({
            stationName: item.stationName,
            fromLineShort: item.fromLineShort,
            toLineShort: item.toLineShort,
            walk_time_seconds: Math.round(Math.min(Math.max(minutes, 1), 6) * 60)
          });
        }
      }
    } catch {
      // ignore
    }
    await sleep(delayMs);
  }
  return out;
}

export function adjacentKey(fromName: string, toName: string): string {
  const a = foldStationName(fromName);
  const b = foldStationName(toName);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function transferKey(station: string, fromShort: string, toShort: string): string {
  const [a, b] = [fromShort, toShort].sort();
  return `${foldStationName(station)}|${a}|${b}`;
}
