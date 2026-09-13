import { haversineKm, type LonLat } from '../geocode/index.js';

interface Entry<T> {
  item: T;
  lon: number;
  lat: number;
}

export interface SpatialIndex<T> {
  nearest(query: LonLat, k?: number): Array<{ item: T; distance: number }>;
}

/**
 * Build a spatial index sorted by longitude for nearest-neighbour search
 * with early termination. Binary-searches for the query longitude, then
 * scans outward — stops when both sides' longitude difference exceeds the
 * current best haversine distance.
 *
 * O(n log n) build, O(n) worst-case query but O(k) average for metro-scale
 * datasets (~1000 stations) due to early exit.
 */
export function buildSpatialIndex<T>(items: T[], coord: (item: T) => LonLat): SpatialIndex<T> {
  const entries: Entry<T>[] = items.map((item) => {
    const { lon, lat } = coord(item);
    return { item, lon, lat };
  });
  entries.sort((a, b) => a.lon - b.lon);

  return {
    nearest(query, k = 1) {
      const { lon: qlon } = query;

      // Binary search for the insertion point
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].lon < qlon) lo = mid + 1;
        else hi = mid;
      }

      const results: Array<{ item: T; distance: number }> = [];
      let bestDist = Infinity;
      let left = lo - 1;
      let right = lo;

      while (left >= 0 || right < entries.length) {
        const dLeft = left >= 0 ? Math.abs(entries[left].lon - qlon) : Infinity;
        const dRight = right < entries.length ? Math.abs(entries[right].lon - qlon) : Infinity;

        // Lon-difference is a lower bound on haversine distance.
        // If both sides exceed the current best, no closer station exists.
        if (dLeft > bestDist && dRight > bestDist) break;

        const entry = dLeft <= dRight ? entries[left--] : entries[right++];
        const dist = haversineKm(query, { lon: entry.lon, lat: entry.lat });
        if (dist < bestDist) bestDist = dist;

        if (results.length < k) {
          results.push({ item: entry.item, distance: dist });
          results.sort((a, b) => a.distance - b.distance);
        } else if (dist < results[k - 1]!.distance) {
          results[k - 1] = { item: entry.item, distance: dist };
          results.sort((a, b) => a.distance - b.distance);
        }
      }

      return results.slice(0, k);
    }
  };
}
