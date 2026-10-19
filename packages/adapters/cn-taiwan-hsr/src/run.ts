import { findRepoRoot, networkDataDir, writeRailNetwork } from '@openmetro/core';
import { fetchThsrSources } from './fetch.js';
import { NETWORK_ID, normalizeThsr } from './normalize.js';
export async function runThsrNormalize(
  root = findRepoRoot(),
  dataDir = networkDataDir(NETWORK_ID, root)
) {
  await writeRailNetwork({ root, dataDir, ...normalizeThsr(await fetchThsrSources()) });
}
if (import.meta.main) await runThsrNormalize();
