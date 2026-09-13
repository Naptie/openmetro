import { getCurvePoints } from 'cardinal-spline-js';

/**
 * Smooth a polyline through every input point using an interpolating
 * cardinal spline (Catmull-Rom family, tension 0.5) via cardinal-spline-js.
 *
 * The spline *interpolates*: the rendered line is guaranteed to pass exactly
 * through every station coordinate, so station dots always sit on the line.
 */
export function smoothLine(coords: [number, number][], samplesPerSegment = 12): [number, number][] {
  if (coords.length < 3) return coords;

  // Collapse consecutive duplicates (e.g. loop closure points) so the spline
  // never hits zero-length spans.
  const deduped: [number, number][] = [];
  for (const c of coords) {
    const last = deduped[deduped.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) deduped.push(c);
  }
  if (deduped.length < 3) return deduped;

  const flat: number[] = [];
  for (const [x, y] of deduped) flat.push(x, y);
  const out = getCurvePoints(flat, 0.5, samplesPerSegment, false);

  const result: [number, number][] = [];
  for (let i = 0; i + 1 < out.length; i += 2) result.push([out[i], out[i + 1]]);
  return result;
}
