/**
 * City-agnostic adapter contract.
 *
 * Every adapter package (`packages/adapters/<network-id>`) exports an
 * `AdapterManifest`. Root scripts and CI discover packages by scanning
 * `package.json` (`openmetro.networkId` / `openmetro.entry`) and only call these methods —
 * they never import city-specific fetch/normalize internals.
 *
 * An adapter always fetches the official sources and writes canonical files in
 * a single pass; there is no separate snapshot step or offline mode.
 */

/**
 * Sync layers. Frequency is a CI policy, not an adapter concern.
 *
 * `gapfill` is adapter-agnostic (core Baidu planner harvest): it only fills
 * weak/missing segment times, distances and transfer walks. Official
 * operator metrics always win. Like `fares`, it is opt-in in `data:sync`.
 */
export type SyncLayer = 'topology' | 'timetables' | 'fares' | 'enrichment' | 'gapfill';

export const SYNC_LAYERS: readonly SyncLayer[] = [
  'topology',
  'timetables',
  'fares',
  'enrichment',
  'gapfill'
] as const;

export interface SyncCtx {
  /** Absolute path to `data/<network-id>`. */
  dataDir: string;
  signal?: AbortSignal;
}

export interface LayerCapability {
  supported: boolean;
  /** Rough wall-clock minutes, used for CI timeouts. */
  estimatedMinutes?: number;
}

export interface AdapterManifest {
  networkId: string;
  displayName: { zh: string; en: string };
  layers: Record<SyncLayer, LayerCapability>;
  /** Fetch official sources and write canonical files under `dataDir`. */
  sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void>;
}
