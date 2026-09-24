/**
 * One-shot: harvest official getTravel.dis onto segments, then fill fare nulls
 * via neighbor official-price mode + mileage formula on official path km.
 *
 *   bun run scripts/chengdu-official-gaps.ts [--skip-distances]
 */
import {
  applyOfficialSegmentDistances,
  harvestOfficialSegmentDistances
} from '../packages/adapters/cn-chengdu/src/distances.js';
import { fillFareGaps } from '../packages/adapters/cn-chengdu/src/fill-gaps.js';

const dataDir = process.env.OPENMETRO_ROOT
  ? `${process.env.OPENMETRO_ROOT}/data/cn-chengdu`
  : 'data/cn-chengdu';

async function main(): Promise<void> {
  const skipDist = process.argv.includes('--skip-distances');
  if (!skipDist) {
    console.log('harvest official planner path distances (getTravel.dis)');
    const cache = await harvestOfficialSegmentDistances(dataDir);
    await applyOfficialSegmentDistances(dataDir, cache);
  } else {
    console.log('skip distance harvest; apply cached official distances only');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const cache = JSON.parse(await readFile(join(dataDir, 'official-distances.json'), 'utf-8')) as {
      meters: Record<string, number>;
    };
    await applyOfficialSegmentDistances(dataDir, cache);
  }
  console.log('fill fare gaps (neighbor mode + formula on official distances)');
  await fillFareGaps(dataDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
