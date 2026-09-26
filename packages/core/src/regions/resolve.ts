import type { City } from '../schema/city.js';
import type { FlatRegion, RegionIndex } from './types.js';

/**
 * Resolve a worldwide-regions id into the canonical `City` block.
 *
 * `name` / `population` / `area` / `location` come from the region record.
 * `country` is the top-level ancestor id (e.g. CN-3205 → CN-32 → CN).
 */
export function resolveCity(regions: RegionIndex, cityId: string): City {
  const region = regions.get(cityId);
  if (!region) {
    throw new Error(`city id ${cityId} not found in worldwide-regions dataset`);
  }
  let country = region.id;
  let cur: FlatRegion | undefined = region;
  const seen = new Set<string>([region.id]);
  while (cur?.parentId) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent: FlatRegion | undefined = regions.get(cur.parentId);
    if (!parent) break;
    country = parent.id;
    cur = parent;
  }
  const zh = region.name.zh ?? region.name.en ?? region.id;
  const en = region.name.en ?? region.name.zh ?? region.id;
  return {
    id: region.id,
    name: { zh, en },
    country,
    population: region.population,
    area: region.area,
    location: region.location
  };
}

/**
 * Placeholder city carrying only the region id. Adapters emit this so they
 * never hand-maintain population/area/coordinates; `apply-city-metadata`
 * overwrites the whole block from worldwide-regions.
 */
export function placeholderCity(regionId: string): City {
  return {
    id: regionId,
    name: { zh: regionId, en: regionId },
    country: '',
    population: null,
    area: null,
    location: null
  };
}
