import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsNetworkSource } from '../data/fs.js';
import { createApiApp } from './app.js';

export type { App } from './app.js';
export { createApiApp } from './app.js';

/**
 * Resolve the canonical data directory (defaults to `<repo-root>/data`).
 *
 * Resolution order:
 *  1. `OPENMETRO_DATA_ROOT` env var (resolved against cwd, may be absolute).
 *  2. Walk up from this module to find the workspace root (a directory that
 *     contains both a `data/` directory and a `package.json`), then use
 *     `<root>/data`.
 *
 * This makes the API work regardless of the current working directory, so
 * `bun run api` from any package still finds the data.
 */
function resolveDataRoot(): string {
  const env = process.env.OPENMETRO_DATA_ROOT;
  if (env) return resolve(env);

  // Walk up from this module: packages/core/src/api -> ... -> repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'data')) && existsSync(join(dir, 'package.json'))) {
      return join(dir, 'data');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to cwd-relative.
  return resolve('data');
}

/**
 * Node/Bun API app over the filesystem `data/` directory. Runtimes without a
 * filesystem (e.g. Cloudflare Workers) call `createApiApp` with a memory source
 * instead.
 */
export function createApp() {
  return createApiApp(createFsNetworkSource(resolveDataRoot()));
}

// Standalone entry: start listening (used by `bun run api`).
if (process.argv[1]?.endsWith('server.ts')) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 8790);
  app.listen(port);
  console.log(`Open Metro API listening on http://localhost:${port}`);
}
