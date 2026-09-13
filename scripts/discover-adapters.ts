/**
 * Discover adapter packages under `packages/adapters/`.
 *
 * A package is an adapter when its package.json has:
 *   - name starting with `@openmetro/adapter-`
 *   - `openmetro.networkId` (and optional `openmetro.entry` / `openmetro.displayName`)
 *
 * Usage:
 *   bun run scripts/discover-adapters.ts
 *   bun run scripts/discover-adapters.ts --json
 *   bun run scripts/discover-adapters.ts --github-output
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DiscoveredAdapter {
  networkId: string;
  name: string;
  dir: string;
  entry: string;
  displayName: { zh: string; en: string };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ADAPTERS_DIR = join(ROOT, 'packages/adapters');

export async function discoverAdapters(): Promise<DiscoveredAdapter[]> {
  const entries = await readdir(ADAPTERS_DIR, { withFileTypes: true });
  const out: DiscoveredAdapter[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgPath = join(ADAPTERS_DIR, e.name, 'package.json');
    let pkg: {
      name?: string;
      openmetro?: {
        networkId?: string;
        entry?: string;
        displayName?: { zh?: string; en?: string };
      };
    };
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!pkg.name?.startsWith('@openmetro/adapter-')) continue;
    const networkId = pkg.openmetro?.networkId;
    if (!networkId) continue;
    out.push({
      networkId,
      name: pkg.name,
      dir: join(ADAPTERS_DIR, e.name),
      entry: resolve(ADAPTERS_DIR, e.name, pkg.openmetro?.entry ?? './src/adapter.ts'),
      displayName: {
        zh: pkg.openmetro?.displayName?.zh ?? networkId,
        en: pkg.openmetro?.displayName?.en ?? networkId
      }
    });
  }
  return out.sort((a, b) => a.networkId.localeCompare(b.networkId));
}

async function main() {
  const adapters = await discoverAdapters();
  const args = process.argv.slice(2);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        adapters.map((a) => ({
          networkId: a.networkId,
          name: a.name,
          displayName: a.displayName
        })),
        null,
        2
      )
    );
    return;
  }

  if (args.includes('--github-output')) {
    const ids = adapters.map((a) => a.networkId);
    // Layer support is declared on AdapterManifest; data:sync --list loads manifests.
    // Static discovery assumes every adapter participates in both matrices; a
    // job no-ops when the adapter marks a layer unsupported.
    const lines = [
      `networks=${JSON.stringify(ids)}`,
      `topology=${JSON.stringify(ids)}`,
      `fares=${JSON.stringify(ids)}`
    ];
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(outFile, `${lines.join('\n')}\n`, 'utf-8');
    }
    for (const l of lines) console.log(l);
    return;
  }

  for (const a of adapters) {
    console.log(`${a.networkId}\t${a.displayName.en}\t${a.name}\t${a.dir}`);
  }
  if (adapters.length === 0) console.error('no adapters found');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
