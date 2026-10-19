import { findRepoRoot, networkDataDir, prepareFeedNetwork, writeCanonical } from '@openmetro/core';
import { fetchTaipeiSources } from './fetch.js';
import { mergeTaipeiMetro } from './metro.js';
import { fetchNewTaipeiSources } from './new-taipei/fetch.js';
import { normalizeNewTaipei } from './new-taipei/normalize.js';
import { NETWORK_ID, normalizeTaipei } from './normalize.js';
import { fetchTaoyuanSources } from './taoyuan/fetch.js';
import { normalizeTaoyuan } from './taoyuan/normalize.js';

export async function runTaipeiNormalize(
  root = findRepoRoot(),
  dataDir = networkDataDir(NETWORK_ID, root)
) {
  const taipei = normalizeTaipei(await fetchTaipeiSources());
  const newTaipei = normalizeNewTaipei(await fetchNewTaipeiSources());
  const taoyuan = normalizeTaoyuan(await fetchTaoyuanSources());
  const merged = mergeTaipeiMetro(
    [taipei, newTaipei, taoyuan].map((source) => ({
      data: prepareFeedNetwork(source),
      sources: source.sources
    }))
  );
  await writeCanonical(dataDir, NETWORK_ID, merged.data, merged.sources);
  console.log(
    `[${NETWORK_ID}] ${merged.data.lines.length} lines, ${merged.data.stations.length} stations`
  );
}
if (import.meta.main) await runTaipeiNormalize();
