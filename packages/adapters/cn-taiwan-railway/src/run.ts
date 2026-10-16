import { findRepoRoot, networkDataDir, writeRailNetwork } from '@openmetro/core';
import { fetchTraSources } from './fetch.js';
import { NETWORK_ID, normalizeTra } from './normalize.js';
export async function runTraNormalize(
  root = findRepoRoot(),
  dataDir = networkDataDir(NETWORK_ID, root)
) {
  await writeRailNetwork({ root, dataDir, ...normalizeTra(await fetchTraSources()) });
}
if (import.meta.main) await runTraNormalize();
