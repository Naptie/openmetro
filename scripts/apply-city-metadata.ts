/**
 * Overwrite `data/<network>/network.json` city metadata from the latest
 * worldwide-regions release. City ids come from adapter `package.json`
 * (`openmetro.cityId`) — the only hand-maintained city field.
 *
 *   bun run data:cities
 *   bun run data:cities --network cn-hongkong
 *
 * Always downloads the latest release; nothing is cached in the repo.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCityMetadata } from '../packages/core/src/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--network');
  const network = i >= 0 ? argv[i + 1] : undefined;
  return { networks: network && network !== 'all' ? [network] : undefined };
}

async function main() {
  const args = parseArgs();
  const result = await applyCityMetadata({ root: ROOT, networks: args.networks });
  console.log(`worldwide-regions release: ${result.tag}`);
  if (result.updated.length === 0) {
    console.log('city metadata already up to date');
    return;
  }
  for (const u of result.updated) {
    console.log(`[${u.networkId}] city <- ${u.cityId} (country ${u.country})`);
  }
  console.log(`updated ${result.updated.length} network(s)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
