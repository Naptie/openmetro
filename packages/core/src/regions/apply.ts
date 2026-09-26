import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { City } from '../schema/city.js';
import { loadWorldwideRegions } from './download.js';
import { resolveCity } from './resolve.js';
import type { RegionIndex } from './types.js';

export interface ApplyCityOptions {
  /** Absolute repo root containing `data/` and `packages/adapters/`. */
  root: string;
  /** Network ids to patch; default: every network that has an adapter cityId. */
  networks?: string[];
  /** Preloaded index (tests). When set, no download happens. */
  regions?: RegionIndex;
  regionsTag?: string;
}

export interface ApplyCityResult {
  tag: string;
  updated: { networkId: string; cityId: string; country: string }[];
}

interface NetworkDoc {
  city?: { id?: string };
  [k: string]: unknown;
}

/**
 * Overwrite `data/<network>/network.json` `city` from worldwide-regions.
 *
 * `cityId` is read from `packages/adapters/<dir>/package.json`
 * `openmetro.cityId` — the only hand-maintained city field.
 */
export async function applyCityMetadata(opts: ApplyCityOptions): Promise<ApplyCityResult> {
  const { root } = opts;
  let index = opts.regions;
  let tag = opts.regionsTag ?? 'preloaded';
  if (!index) {
    const loaded = await loadWorldwideRegions();
    index = loaded.index;
    tag = loaded.tag;
  }

  const cityIdByNetwork = await readCityIds(root);
  const networkIds =
    opts.networks ?? [...cityIdByNetwork.keys()].sort((a, b) => a.localeCompare(b));

  const updated: ApplyCityResult['updated'] = [];
  for (const networkId of networkIds) {
    const cityId = cityIdByNetwork.get(networkId);
    if (!cityId) {
      throw new Error(
        `no openmetro.cityId in packages/adapters/*/package.json for network ${networkId}`
      );
    }
    const city: City = resolveCity(index, cityId);
    const netPath = join(root, 'data', networkId, 'network.json');
    let doc: NetworkDoc;
    try {
      doc = JSON.parse(await readFile(netPath, 'utf-8')) as NetworkDoc;
    } catch {
      continue; // network not synced yet
    }
    if (JSON.stringify(doc.city) === JSON.stringify(city)) continue;
    doc.city = city;
    await writeFile(netPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
    updated.push({ networkId, cityId: city.id, country: city.country });
  }
  return { tag, updated };
}

/** `networkId → openmetro.cityId` from every adapter package. */
export async function readCityIds(root: string): Promise<Map<string, string>> {
  const adaptersDir = join(root, 'packages', 'adapters');
  const out = new Map<string, string>();
  for (const e of await readdir(adaptersDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pkgPath = join(adaptersDir, e.name, 'package.json');
    let pkg: {
      name?: string;
      openmetro?: { networkId?: string; cityId?: string };
    };
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!pkg.name?.startsWith('@openmetro/adapter-')) continue;
    const networkId = pkg.openmetro?.networkId;
    const cityId = pkg.openmetro?.cityId;
    if (networkId && cityId) out.set(networkId, cityId);
  }
  return out;
}
