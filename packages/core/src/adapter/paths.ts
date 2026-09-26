/**
 * City-agnostic path helpers shared by every adapter package.
 *
 * Adapters must not re-implement repo-root discovery or network data-dir
 * resolution — those are workspace conventions, not city logic.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `startDir` (or this file) until a directory that contains both
 * `packages/adapters` and `package.json` — the monorepo root.
 */
export function findRepoRoot(startDir?: string): string {
  if (process.env.OPENMETRO_ROOT) return process.env.OPENMETRO_ROOT;
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'packages', 'adapters')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

/**
 * Repository root that contains `data/<networkId>`.
 * `dataDir` is typically `SyncCtx.dataDir`.
 */
export function repoRootForDataDir(dataDir: string, networkId: string): string {
  const escaped = networkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = dataDir.match(new RegExp(`^(.*?)[/\\\\]data[/\\\\]${escaped}$`));
  return m?.[1] || findRepoRoot();
}

/** Absolute path of `data/<networkId>` under the repo root. */
export function networkDataDir(networkId: string, root?: string): string {
  return join(root ?? findRepoRoot(), 'data', networkId);
}
