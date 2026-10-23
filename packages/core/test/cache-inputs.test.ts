import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { findRepoRoot } from '../src/adapter/paths.js';

/**
 * Caches are optimisations, never inputs.
 *
 * A test that reads a cache path breaks on every clean checkout: CI has no
 * cache, so the test fails for a reason that has nothing to do with the code
 * under test — and the failure is indistinguishable from a real regression.
 *
 * A test that needs an external file must fetch it through the adapter's own
 * acquisition function, exactly like the sync pipeline does.
 */
const FORBIDDEN = ['tmp/cache', 'adapterCacheDir', 'adapterOsCacheDir'] as const;

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(full));
    else if (entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

test('adapter tests never read a cache path', () => {
  const root = findRepoRoot();
  const adaptersDir = join(root, 'packages', 'adapters');
  const offenders: string[] = [];

  for (const city of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!city.isDirectory()) continue;
    let files: string[] = [];
    try {
      files = collectTestFiles(join(adaptersDir, city.name, 'test'));
    } catch {
      continue; // this adapter has no test directory
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const needle of FORBIDDEN) {
        if (source.includes(needle)) {
          offenders.push(`${relative(root, file)} references ${needle}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'adapter tests must fetch external files, not read cache directories'
  );
});
