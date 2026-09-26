import { parseRegionsCsv } from './parse.js';
import type { RegionIndex } from './types.js';

export const WORLDWIDE_REGIONS_REPO = 'Naptie/worldwide-regions';
export const REGIONS_FLAT_ASSET = 'regions-flat.csv';

interface LatestRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * Download the latest worldwide-regions release asset and parse it.
 *
 * Always fetches the live latest release — nothing is cached in the repo or
 * on disk. Uses `releases/latest/download/<asset>` (no GitHub API) so runners
 * do not hit the REST rate limit; the release tag is resolved separately when
 * the API is available.
 */
export async function loadWorldwideRegions(
  opts: {
    repo?: string;
    assetName?: string;
    /** Override the download URL (tests / mirrors). */
    downloadUrl?: string;
    /** Existing CSV text — skips the network entirely (tests). */
    csvText?: string;
  } = {}
): Promise<{ index: RegionIndex; tag: string }> {
  if (opts.csvText != null) {
    return { index: parseRegionsCsv(opts.csvText), tag: opts.downloadUrl ?? 'inline' };
  }

  const repo = opts.repo ?? WORLDWIDE_REGIONS_REPO;
  const assetName = opts.assetName ?? REGIONS_FLAT_ASSET;
  const downloadUrl =
    opts.downloadUrl ?? `https://github.com/${repo}/releases/latest/download/${assetName}`;

  let tag = 'latest';
  try {
    tag = (await fetchJson<LatestRelease>(`https://api.github.com/repos/${repo}/releases/latest`))
      .tag_name;
  } catch {
    // Rate-limited or offline metadata: still download the latest asset.
  }

  const res = await fetch(downloadUrl, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000)
  });
  if (!res.ok) throw new Error(`GET ${downloadUrl} -> ${res.status} ${res.statusText}`);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf-8');
  return { index: parseRegionsCsv(text), tag };
}
