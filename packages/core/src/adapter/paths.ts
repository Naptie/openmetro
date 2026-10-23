/**
 * City-agnostic path helpers shared by every adapter package.
 *
 * Adapters must not re-implement repo-root discovery or network data-dir
 * resolution — those are workspace conventions, not city logic.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Scratch cache dir for adapter-side artifacts that must never appear in the
 * canonical `data/<networkId>/` tree (planner distance caches, downloaded
 * source workbooks, …). Lives under the git-ignored `tmp/` scratch dir so
 * every city's data folder stays identical: the canonical files only.
 * Contents are regenerable — caches only exist to spare repeat planner
 * queries.
 */
export function adapterCacheDir(networkId: string, root?: string): string {
  return join(root ?? findRepoRoot(), 'tmp', 'cache', networkId);
}

/**
 * Machine-local scratch cache outside the repository.
 *
 * Use this for external files that are cheap to re-fetch but must never be
 * mistaken for repository inputs — the operator-published fare workbook the
 * Qingdao adapter downloads on every run is the canonical example. Keeping
 * them under the OS temp dir instead of the repo's `tmp/` makes it impossible
 * to read a cached copy as if it were a committed artifact, and the OS temp
 * dir is machine-local scratch by definition.
 *
 * A cache is an optimisation, never an input: a test that needs the file
 * must fetch it, not read this directory.
 */
export function adapterOsCacheDir(networkId: string): string {
  return join(tmpdir(), 'openmetro-cache', networkId);
}
