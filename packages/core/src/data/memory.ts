import { Effect } from "effect";
import { decodeNetworkData, decodeNetworkMeta } from "./decode.js";
import type { NetworkSource, RawNetworkFiles } from "./source.js";

/**
 * In-memory network source. Used by runtimes without a filesystem (e.g. the
 * Cloudflare Worker), where the canonical JSON is bundled at build time.
 */
export function createMemoryNetworkSource(files: Record<string, RawNetworkFiles>): NetworkSource {
  const ids = Object.keys(files).sort();
  return {
    list: async () => ids,
    load: (id) => {
      const raw = files[id];
      return raw ? decodeNetworkData(raw) : Effect.fail(new Error(`unknown network ${id}`));
    },
    loadMeta: (id) => {
      const raw = files[id];
      return raw ? decodeNetworkMeta(raw.network) : Effect.fail(new Error(`unknown network ${id}`));
    },
  };
}
