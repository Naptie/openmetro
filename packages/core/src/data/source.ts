import type { Effect } from "effect";
import type { NetworkEncoded } from "../schema/index.js";
import type { NetworkData } from "./types.js";

export type { RawNetworkFiles } from "./types.js";

/**
 * A pluggable source of canonical network data. The filesystem implementation
 * is used by the Node/Bun API and CLI; a memory implementation is used by the
 * Cloudflare Worker (which has no filesystem).
 */
export interface NetworkSource {
  /** List available network ids. */
  list(): Promise<string[]>;
  /** Load and validate one network's full data. */
  load(id: string): Effect.Effect<NetworkData, unknown>;
  /** Load and validate one network's metadata only. */
  loadMeta(id: string): Effect.Effect<NetworkEncoded, unknown>;
}
