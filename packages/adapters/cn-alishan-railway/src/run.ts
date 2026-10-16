import { findRepoRoot, networkDataDir, writeRailNetwork } from '@openmetro/core';
import { fetchAlishanSources } from './fetch.js';
import { NETWORK_ID, normalizeAlishan } from './normalize.js';
export async function runAlishanNormalize(
  root = findRepoRoot(),
  dataDir = networkDataDir(NETWORK_ID, root)
) {
  await writeRailNetwork({ root, dataDir, ...normalizeAlishan(await fetchAlishanSources()) });
}
if (import.meta.main) await runAlishanNormalize();
