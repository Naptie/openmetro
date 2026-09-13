import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { decodeNetworkData, decodeNetworkMeta } from './decode.js';
import { listNetworks } from './networks.js';
import type { NetworkSource, RawNetworkFiles } from './source.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  return readJson(path);
}

/** Filesystem-backed network source (`data/<network-id>/*.json`). */
export function createFsNetworkSource(dataRoot: string): NetworkSource {
  const readFiles = async (id: string): Promise<RawNetworkFiles> => {
    const dir = join(dataRoot, id);
    const [network, lines, stations, stops, patterns, segments, transfers, timetables, fares] =
      await Promise.all([
        readJson(join(dir, 'network.json')),
        readJson(join(dir, 'lines.json')),
        readJson(join(dir, 'stations.json')),
        readJson(join(dir, 'stops.json')),
        readOptionalJson(join(dir, 'patterns.json')),
        readJson(join(dir, 'segments.json')),
        readJson(join(dir, 'transfers.json')),
        readOptionalJson(join(dir, 'timetables.json')),
        readOptionalJson(join(dir, 'fares.json'))
      ]);
    return { network, lines, stations, stops, patterns, segments, transfers, timetables, fares };
  };

  return {
    list: () => listNetworks(dataRoot),
    load: (id) => Effect.tryPromise(() => readFiles(id)).pipe(Effect.flatMap(decodeNetworkData)),
    loadMeta: (id) =>
      Effect.tryPromise(() => readJson(join(dataRoot, id, 'network.json'))).pipe(
        Effect.flatMap(decodeNetworkMeta)
      )
  };
}
