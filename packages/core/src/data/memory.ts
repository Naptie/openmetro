import { Effect } from 'effect';
import type { NetworkEncoded } from '../schema/index.js';
import { decodeNetworkData, decodeNetworkMeta } from './decode.js';
import type { NetworkSource, RawNetworkFiles } from './source.js';
import type { NetworkData } from './types.js';

/**
 * In-memory network source. Used by runtimes where loading files at request
 * time is awkward (e.g. the Vercel function), where the canonical JSON is
 * bundled at build time.
 *
 * Decoded results are cached per network id for the lifetime of the isolate.
 * Effect Schema validation of the full dataset is expensive (hundreds of ms
 * of CPU); without this cache every request re-pays that cost. Bundled-data
 * serverless runtimes should keep this per-isolate cache.
 */
export function createMemoryNetworkSource(files: Record<string, RawNetworkFiles>): NetworkSource {
  const ids = Object.keys(files).sort();
  const dataCache = new Map<string, NetworkData>();
  const metaCache = new Map<string, NetworkEncoded>();

  return {
    list: async () => ids,
    load: (id) => {
      const cached = dataCache.get(id);
      if (cached) return Effect.succeed(cached);
      const raw = files[id];
      if (!raw) return Effect.fail(new Error(`unknown network ${id}`));
      return decodeNetworkData(raw).pipe(
        Effect.map((data) => {
          dataCache.set(id, data);
          return data;
        })
      );
    },
    loadMeta: (id) => {
      const cached = metaCache.get(id);
      if (cached) return Effect.succeed(cached);
      const raw = files[id];
      if (!raw) return Effect.fail(new Error(`unknown network ${id}`));
      return decodeNetworkMeta(raw.network).pipe(
        Effect.map((meta) => {
          metaCache.set(id, meta);
          return meta;
        })
      );
    }
  };
}
