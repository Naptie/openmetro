import type { Effect } from 'effect';
import type { NetworkEncoded } from '../schema/index.js';
import { createFsNetworkSource } from './fs.js';
import type { NetworkData } from './types.js';

export type { NetworkData, RawNetworkFiles } from './types.js';

/**
 * Load and validate only `network.json` (cheap: used by the networks index).
 * Filesystem-backed convenience wrapper; runtimes without a filesystem should
 * use `createMemoryNetworkSource` with `createApiApp`.
 */
export function loadNetworkMeta(
  dataRoot: string,
  networkId: string
): Effect.Effect<NetworkEncoded, unknown> {
  return createFsNetworkSource(dataRoot).loadMeta(networkId);
}

/** Load and validate a full network from `data/<network-id>/`. */
export function loadNetwork(
  dataRoot: string,
  networkId: string
): Effect.Effect<NetworkData, unknown> {
  return createFsNetworkSource(dataRoot).load(networkId);
}
