/**
 * Vercel's build may write SvelteKit static output to Build Output API paths
 * instead of packages/web/build. Materialize the directory vercel.json expects.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'packages/web/build');
const candidates = [
  join(root, '.vercel/output/static'),
  join(root, 'packages/web/.vercel/output/static'),
  join(root, 'packages/web/build')
];

function hasIndex(dir) {
  return existsSync(join(dir, 'index.html'));
}

if (hasIndex(dest) && readdirSync(dest).length > 0) {
  console.log('ensure-vercel-static: packages/web/build already present');
  process.exit(0);
}

const source = candidates.find((dir) => dir !== dest && existsSync(dir) && hasIndex(dir));
if (!source) {
  console.error(
    'ensure-vercel-static: no static output found in packages/web/build or .vercel/output/static'
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(source, dest, { recursive: true });
console.log(`ensure-vercel-static: copied ${source} -> ${dest}`);
