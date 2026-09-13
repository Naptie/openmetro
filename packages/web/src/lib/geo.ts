import { getCurvePoints } from 'cardinal-spline-js';

/** Samples per input segment used by the spline. Kept point i sits at index i * this. */
export const SMOOTH_SAMPLES = 12;

/**
 * Smooth a polyline through every input point using an interpolating
 * cardinal spline (Catmull-Rom family, tension 0.5) via cardinal-spline-js.
 *
 * The spline *interpolates*: the rendered line is guaranteed to pass exactly
 * through every station coordinate, so station dots always sit on the line.
 */
export function smoothLine(
  coords: [number, number][],
  samplesPerSegment = SMOOTH_SAMPLES
): [number, number][] {
  return smoothLineWithStops(coords, samplesPerSegment).smoothed;
}

/**
 * Same as smoothLine, but also reports where each original vertex landed in
 * the output. Consecutive duplicates are collapsed before fitting the spline;
 * dropped vertices map to the same output index as their kept neighbour.
 */
export function smoothLineWithStops(
  coords: [number, number][],
  samplesPerSegment = SMOOTH_SAMPLES
): { smoothed: [number, number][]; stopIndices: number[] } {
  const n = coords.length;
  if (n === 0) return { smoothed: [], stopIndices: [] };

  const kept: [number, number][] = [];
  const keptFrom: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    const last = kept[kept.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) {
      kept.push(c);
      keptFrom.push(i);
    }
  }

  const mapToKept = (smoothed: [number, number][], lastIndexIsExact: boolean): number[] => {
    const stopIndices = new Array<number>(n);
    const outIndex = (k: number): number => {
      if (kept.length === 1) return 0;
      if (k === kept.length - 1)
        return lastIndexIsExact
          ? smoothed.length - 1
          : Math.min(k * samplesPerSegment, smoothed.length - 1);
      return k * samplesPerSegment;
    };
    let prev = 0;
    let keptPtr = 0;
    for (let i = 0; i < n; i++) {
      if (keptPtr < keptFrom.length && keptFrom[keptPtr] === i) {
        prev = outIndex(keptPtr);
        keptPtr += 1;
      }
      stopIndices[i] = prev;
    }
    return stopIndices;
  };

  if (kept.length < 3) {
    return { smoothed: kept, stopIndices: mapToKept(kept, true) };
  }

  const flat: number[] = [];
  for (const [x, y] of kept) flat.push(x, y);
  const out = getCurvePoints(flat, 0.5, samplesPerSegment, false);

  const smoothed: [number, number][] = [];
  for (let i = 0; i + 1 < out.length; i += 2) smoothed.push([out[i], out[i + 1]]);
  return { smoothed, stopIndices: mapToKept(smoothed, true) };
}

/**
 * One continuous polyline as drawn on the map (line trunk, or one side of a
 * branch). `smoothed` is the full interpolation of `stationIds` — the same
 * input the map used when drawing the line.
 */
export interface DrawnLinePath {
  lineId: string;
  stationIds: string[];
  /** Smoothed polyline matching the drawn line feature. */
  smoothed: [number, number][];
  /** `stopIndices[i]` is the index in `smoothed` of `stationIds[i]`. */
  stopIndices: number[];
}

function occurrences(ids: string[], stationId: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) if (ids[i] === stationId) out.push(i);
  return out;
}

/**
 * Slice a drawn path between two stations, preserving the drawn curve.
 * Tries every occurrence of each endpoint (loops visit a station twice) and
 * returns the longest forward or reverse slice.
 */
export function clipDrawnPath(
  path: DrawnLinePath,
  fromStationId: string,
  toStationId: string
): [number, number][] | null {
  const fromIdxs = occurrences(path.stationIds, fromStationId);
  const toIdxs = occurrences(path.stationIds, toStationId);
  if (!fromIdxs.length || !toIdxs.length) return null;

  let best: [number, number][] | null = null;
  for (const a of fromIdxs) {
    for (const b of toIdxs) {
      if (a === b) continue;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const slice = path.smoothed.slice(path.stopIndices[lo], path.stopIndices[hi] + 1);
      const oriented = a < b ? slice : slice.slice().reverse();
      if (!best || oriented.length > best.length) best = oriented;
    }
  }
  return best;
}

function longestMatchFrom(
  path: DrawnLinePath,
  leg: string[],
  start: number
): { end: number; coords: [number, number][] } | null {
  const fromStation = leg[start];
  const next = leg[start + 1];
  if (!next) return null;

  let best: { end: number; coords: [number, number][] } | null = null;

  for (const fromIdx of occurrences(path.stationIds, fromStation)) {
    let dir: 1 | -1 | null = null;
    if (fromIdx + 1 < path.stationIds.length && path.stationIds[fromIdx + 1] === next) {
      dir = 1;
    } else if (fromIdx > 0 && path.stationIds[fromIdx - 1] === next) {
      dir = -1;
    } else {
      continue;
    }

    let j = start;
    let k = fromIdx;
    while (
      j + 1 < leg.length &&
      k + dir >= 0 &&
      k + dir < path.stationIds.length &&
      path.stationIds[k + dir] === leg[j + 1]
    ) {
      j += 1;
      k += dir;
    }
    if (j <= start) continue;

    const lo = fromIdx < k ? fromIdx : k;
    const hi = fromIdx < k ? k : fromIdx;
    let coords = path.smoothed.slice(path.stopIndices[lo], path.stopIndices[hi] + 1);
    if (dir === -1) coords = coords.slice().reverse();
    if (!best || j > best.end) best = { end: j, coords };
  }

  return best;
}

/**
 * Build route geometry for one ride leg by clipping the already-drawn line
 * paths. A leg may span a trunk run and a branch run; each piece comes from
 * the same smoothed polyline the map uses for that line, so the route overlay
 * cannot drift off the line.
 */
export function routeGeometryForStationIds(
  stationIds: string[],
  paths: DrawnLinePath[]
): [number, number][] {
  if (stationIds.length < 2) return [];

  const out: [number, number][] = [];
  let i = 0;

  while (i < stationIds.length - 1) {
    let bestEnd = i;
    let bestSlice: [number, number][] | null = null;

    for (const path of paths) {
      const match = longestMatchFrom(path, stationIds, i);
      if (match && match.end > bestEnd) {
        bestEnd = match.end;
        bestSlice = match.coords;
      }
    }

    if (!bestSlice) {
      i += 1;
      continue;
    }

    if (out.length === 0) out.push(...bestSlice);
    else out.push(...bestSlice.slice(1));
    i = bestEnd;
  }

  return out;
}
