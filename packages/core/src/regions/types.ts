import type { City } from '../schema/city.js';

/** Production region record shape from worldwide-regions releases. */
export interface FlatRegion {
  id: string;
  parentId: string | null;
  level: string;
  name: Record<string, string>;
  population: number | null;
  area: number | null;
  location: City['location'];
}

export type RegionIndex = Map<string, FlatRegion>;
