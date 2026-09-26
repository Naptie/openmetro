/**
 * GCJ-02 ↔ BD-09 (Baidu) coordinate transforms.
 *
 * Single source of truth for the Baidu offset twist. Every adapter and the
 * gapfill client must import from here — never re-implement the formulas.
 *
 * Argument order is `(lat, lng)` for both directions (Baidu Web API order).
 * Canonical station coordinates in this project are GCJ-02.
 */

const BD_X_PI = (Math.PI * 3000.0) / 180.0;

export interface LatLng {
  lat: number;
  lng: number;
}

/** GCJ-02 → BD-09 (Baidu). */
export function gcj02ToBd09(lat: number, lng: number): LatLng {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * BD_X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * BD_X_PI);
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006
  };
}

/** BD-09 (Baidu) → GCJ-02. */
export function bd09ToGcj02(lat: number, lng: number): LatLng {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * BD_X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_X_PI);
  return {
    lng: z * Math.cos(theta),
    lat: z * Math.sin(theta)
  };
}
