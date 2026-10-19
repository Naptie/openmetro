import type { StationMap } from './fetch.js';

export const OSM_API = 'https://api.openstreetmap.org/api/0.6/';
export interface RailNode {
  id: number;
  type: string;
  lon: number;
  lat: number;
  tags?: Record<string, string>;
}

const fold = (s: string) =>
  s
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^(輕軌|捷運)/, '')
    .replace(/車站$|站$|\s/g, '')
    .replace(/臺/g, '台')
    .toLowerCase();
const inCity = (lon: number, lat: number) =>
  lon >= 120.15 && lon <= 120.5 && lat >= 22.45 && lat <= 22.95;

/** A matching name is insufficient: TRA, metro and LRT share several names. */
export function matchesRailIdentity(
  node: RailNode,
  station: StationMap,
  codes: string[],
  loop: boolean
): boolean {
  const t = node.tags;
  if (node.type !== 'node' || !inCity(node.lon, node.lat) || !t) return false;
  if (!/^(station|tram_stop|halt)$/.test(t.railway ?? '')) return false;
  if (t.station !== (loop ? 'light_rail' : 'subway')) return false;
  const refs = (t.ref ?? '').split(/[;,/\s]+/);
  if (!codes.some((c) => refs.includes(c))) return false;
  if (!/高雄|Kaohsiung/i.test(`${t.network ?? ''} ${t.operator ?? ''}`)) return false;
  const names = [station.zh, station.en].map(fold);
  return Object.entries(t).some(
    ([k, v]) => /^(name|alt_name)(:|$)/.test(k) && v.split(';').some((n) => names.includes(fold(n)))
  );
}

export async function geocodeRailStation(
  station: StationMap,
  codes: string[],
  loop: boolean,
  getText: (url: string) => Promise<string>
): Promise<{ location: StationMap['location']; osmId: string }> {
  const name = station.zh.replace(/[（(].*?[）)]/g, '');
  const queries = [
    ...(loop ? [`輕軌${name.replace(/站$/, '')}站`] : []),
    `高雄 ${name} ${loop ? '輕軌' : '捷運'}`,
    `高雄 ${station.en}`
  ];
  for (const q of queries) {
    const url = `https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: '20', lat: '22.64', lon: '120.3', bbox: '120.15,22.45,120.5,22.95' })}`;
    const data = JSON.parse(await getText(url)) as {
      features: {
        properties: {
          name?: string;
          osm_type: string;
          osm_id: number;
          osm_key: string;
          osm_value: string;
        };
      }[];
    };
    const ids = [
      ...new Set(
        data.features
          .filter(
            (f) =>
              f.properties.osm_type === 'N' &&
              f.properties.osm_key === 'railway' &&
              /^(station|tram_stop|halt)$/.test(f.properties.osm_value) &&
              [fold(station.zh), fold(station.en)].includes(fold(f.properties.name ?? ''))
          )
          .map((f) => f.properties.osm_id)
      )
    ];
    if (!ids.length) continue;
    const osm = JSON.parse(await getText(`${OSM_API}nodes.json?nodes=${ids.join(',')}`)) as {
      elements: RailNode[];
    };
    const hits = osm.elements.filter((node) => matchesRailIdentity(node, station, codes, loop));
    if (hits.length > 1) throw new Error(`Ambiguous railway identity ${codes.join('/')}`);
    if (hits.length === 1) {
      const hit = hits[0]!;
      return { location: { lon: hit.lon, lat: hit.lat, crs: 'wgs84' }, osmId: `N/${hit.id}` };
    }
  }
  throw new Error(`No verified railway coordinate match for ${codes.join('/')} ${station.zh}`);
}
