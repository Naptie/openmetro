/**
 * Rough metropolitan bboxes (GCJ-02) used to reject absurd geocode hits.
 * Includes metro-area satellite cities served by each network (e.g. GZ
 * includes Foshan / Dongguan / Huizhou / Zhaoqing intercity arms).
 */
export const CITY_BBOX: Record<
  string,
  { lon: [number, number]; lat: [number, number]; center: { lon: number; lat: number } }
> = {
  北京: {
    lon: [115.4, 117.5],
    lat: [39.4, 41.1],
    center: { lon: 116.407, lat: 39.904 },
  },
  上海: {
    lon: [120.8, 122.2],
    lat: [30.7, 31.9],
    center: { lon: 121.47, lat: 31.23 },
  },
  广州: {
    lon: [112.4, 114.8],
    lat: [22.5, 24.2],
    center: { lon: 113.26, lat: 23.13 },
  },
};

export function cityBbox(city: string) {
  const key = city.replace(/市$/, "");
  return CITY_BBOX[key];
}

/** Reject coords far outside the city's metropolitan bbox. */
export function isWithinCityBbox(city: string, lon: number, lat: number, padDeg = 0.35): boolean {
  const box = cityBbox(city);
  if (!box) return true; // unknown city — do not filter
  return (
    lon >= box.lon[0] - padDeg &&
    lon <= box.lon[1] + padDeg &&
    lat >= box.lat[0] - padDeg &&
    lat <= box.lat[1] + padDeg
  );
}
