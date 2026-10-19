import { Effect } from 'effect';
import type { NetworkEncoded } from '../schema/index.js';
import { decodeNetworkData, decodeNetworkMeta } from './decode.js';
import type { NetworkSource } from './source.js';
import type { NetworkData, RawNetworkFiles } from './types.js';

/** Single-file snapshots prevent mixing canonical files from different publishes. */
export function createHttpNetworkSource(
  baseUrl: string,
  fallback: NetworkSource,
  { ttlMs = 5 * 60_000, timeoutMs = 10_000 }: { ttlMs?: number; timeoutMs?: number } = {}
): NetworkSource {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cache = new Map<string, { data: NetworkData; expiresAt: number }>();
  const pending = new Map<string, Promise<NetworkData>>();
  let index: Map<string, NetworkEncoded> | undefined;
  let indexExpiresAt = 0;
  let pendingIndex: Promise<Map<string, NetworkEncoded> | undefined> | undefined;

  const fetchJson = async (file: string): Promise<unknown> => {
    const response = await fetch(new URL(file, root), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
    return response.json();
  };

  const loadIndex = (): Promise<Map<string, NetworkEncoded> | undefined> => {
    if (pendingIndex) return pendingIndex;
    if (Date.now() < indexExpiresAt) return Promise.resolve(index);
    pendingIndex = (async () => {
      try {
        const raw = (await fetchJson('index.json')) as { networks?: unknown };
        if (!Array.isArray(raw?.networks) || raw.networks.length === 0) {
          throw new Error('Missing network metadata index');
        }
        const metadata = await Promise.all(
          raw.networks.map((network) => Effect.runPromise(decodeNetworkMeta(network)))
        );
        index = new Map(metadata.map((network) => [network.id, network]));
      } catch {
        // Retain the last decoded index; a cold isolate can use bundled metadata.
      } finally {
        indexExpiresAt = Date.now() + ttlMs;
        pendingIndex = undefined;
      }
      return index;
    })();
    return pendingIndex;
  };

  const loadData = (id: string): Promise<NetworkData> => {
    const cached = cache.get(id);
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.data);
    const inflight = pending.get(id);
    if (inflight) return inflight;
    const request = (async () => {
      let data: NetworkData;
      try {
        const raw = (await fetchJson(`${encodeURIComponent(id)}.json`)) as RawNetworkFiles;
        // The file decoder permits optional layers for legacy filesystem data;
        // the publication transport always carries all nine canonical documents.
        for (const key of [
          'network',
          'lines',
          'stations',
          'stops',
          'patterns',
          'segments',
          'transfers',
          'timetables',
          'fares'
        ] as const) {
          if (raw?.[key] == null) throw new Error(`Incomplete snapshot: ${key}`);
        }
        data = await Effect.runPromise(decodeNetworkData(raw));
        if (data.network.id !== id) throw new Error(`Snapshot network does not match ${id}`);
      } catch {
        data = cached?.data ?? (await Effect.runPromise(fallback.load(id)));
      } finally {
        pending.delete(id);
      }
      cache.set(id, { data, expiresAt: Date.now() + ttlMs });
      return data;
    })();
    pending.set(id, request);
    return request;
  };

  return {
    list: async () => {
      const metadata = await loadIndex();
      // A deployment can add operators before their first data-branch sync.
      return [...new Set([...(await fallback.list()), ...(metadata?.keys() ?? [])])].sort();
    },
    load: (id) => Effect.tryPromise(() => loadData(id)),
    loadMeta: (id) =>
      Effect.tryPromise(async () => {
        const metadata = await loadIndex();
        return (
          metadata?.get(id) ??
          cache.get(id)?.data.network ??
          Effect.runPromise(fallback.loadMeta(id))
        );
      })
  };
}
