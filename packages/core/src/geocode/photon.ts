/**
 * Free forward geocoding via Photon (OSM-based, no API key).
 *
 * Used after AMap subway + Overpass when a station is missing from those
 * datasets (new trams, renamed stops). Results are WGS84 and converted to
 * GCJ-02. Nominatim itself is often unreachable from some networks; Photon
 * is the practical public alternative.
 */
import { isWithinCityBbox } from "./city-bbox.js";
import type { GeoResult } from "./index.js";
import { wgs84ToGcj02 } from "./overpass.js";

const PHOTON_URL = "https://photon.komoot.io/api/";
const USER_AGENT = "openmetro/0.1 (data enrichment)";

interface PhotonFeature {
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_value?: string;
  };
  geometry?: { coordinates?: [number, number] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** Strip a trailing 村 so 老观里村 can match 老观里. */
function stripVillageSuffix(s: string): string {
  return s.replace(/村$/, "");
}

export async function geocodeViaPhoton(
  name: string,
  city?: string,
  opts: { retries?: number; timeoutMs?: number; lon?: number; lat?: number } = {},
): Promise<GeoResult | undefined> {
  const q = city ? `${name}, ${city}` : name;
  const bias = opts.lon != null && opts.lat != null ? `&lat=${opts.lat}&lon=${opts.lon}` : "";
  const url = `${PHOTON_URL}?limit=5&q=${encodeURIComponent(q)}${bias}`;
  const retries = opts.retries ?? 3;
  let last: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`photon ${res.status}`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { features?: PhotonFeature[] };
      const target = normalize(name);
      const targetBase = normalize(stripVillageSuffix(name));
      for (const f of body.features ?? []) {
        const n = f.properties?.name;
        const coords = f.geometry?.coordinates;
        if (!n || !coords) continue;
        const cand = normalize(n);
        const candBase = normalize(stripVillageSuffix(n));
        if (cand === target || candBase === targetBase || cand === targetBase) {
          const [lon, lat] = coords;
          if (typeof lon === "number" && typeof lat === "number") {
            const geo = wgs84ToGcj02(lon, lat);
            if (city && !isWithinCityBbox(city, geo.lon, geo.lat)) continue;
            return geo;
          }
        }
      }
      return undefined;
    } catch (err) {
      last = err;
      await sleep(800 * 2 ** attempt);
    }
  }
  void last;
  return undefined;
}
