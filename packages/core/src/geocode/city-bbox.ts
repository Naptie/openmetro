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
    center: { lon: 116.407, lat: 39.904 }
  },
  上海: {
    lon: [120.8, 122.2],
    lat: [30.7, 31.9],
    center: { lon: 121.47, lat: 31.23 }
  },
  广州: {
    lon: [112.4, 114.8],
    lat: [22.5, 24.2],
    center: { lon: 113.26, lat: 23.13 }
  },
  // The two-line network (1号线 伊利健康谷—坝堰(机场), 2号线 阿尔山路—塔利东路)
  // spans lon 111.57…111.83 / lat 40.75…40.87; the box leaves margin for the
  // metro area's satellite districts.
  呼和浩特: {
    lon: [111.45, 111.95],
    lat: [40.68, 40.95],
    center: { lon: 111.663, lat: 40.815 }
  }
};

export function cityBbox(city: string) {
  const key = city.replace(/市$/, '');
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
