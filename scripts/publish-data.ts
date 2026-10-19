import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const KEYS = [
  'network',
  'lines',
  'stations',
  'stops',
  'patterns',
  'segments',
  'transfers',
  'timetables',
  'fares'
];

async function directories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

async function requireComplete(root: string): Promise<void> {
  for (const key of KEYS) {
    const path = join(root, `${key}.json`);
    if (!(await stat(path).catch(() => undefined))?.isFile()) {
      throw new Error(`Incomplete network snapshot: ${path}`);
    }
  }
}

/** Seed one adapter's working data without changing the checked-out code revision. */
export async function seedPublishedNetwork(repoRoot: string, networkId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(networkId)) {
    throw new Error(`Invalid network id: ${networkId}`);
  }
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec('git', args, { cwd: repoRoot });
  const remote = await git('ls-remote', '--heads', 'origin', 'refs/heads/data');
  if (!remote.stdout.trim()) return false;
  // Only an absent branch/network is a cold start. Fetch or archive errors must
  // abort the sync instead of allowing old checkout data to replace publication.
  await git('fetch', '--depth=1', 'origin', '+refs/heads/data:refs/remotes/origin/data');
  const sha = (await git('rev-parse', 'refs/remotes/origin/data')).stdout.trim();
  const path = `data/${networkId}`;
  if (!(await git('ls-tree', '--name-only', sha, '--', path)).stdout.trim()) return false;
  const previous = await mkdtemp(join(tmpdir(), 'openmetro-published-'));
  try {
    const archive = join(previous, 'network.tar');
    await git('archive', '--format=tar', '--output', archive, sha, '--', path);
    await exec('tar', ['-xf', archive, '-C', previous]);
    await mergePublishedData(join(repoRoot, 'data'), join(previous, 'data'));
    return true;
  } finally {
    await rm(previous, { recursive: true, force: true });
  }
}

/** Restore the last publication, then replace each successful artifact as a whole. */
export async function mergePublishedData(
  dataRoot: string,
  previousRoot?: string,
  artifactsRoot?: string
): Promise<number> {
  const previous = previousRoot
    ? (await directories(previousRoot)).map((id) => ({
        id,
        path: join(previousRoot, id)
      }))
    : [];
  const staged: { id: string; path: string }[] = [];
  if (artifactsRoot) {
    // One artifact per network contains all the layers requested in this run.
    for (const artifact of await directories(artifactsRoot)) {
      if (!artifact.startsWith('sync-data-')) continue;
      const root = join(artifactsRoot, artifact, 'data');
      for (const id of await directories(root)) staged.push({ id, path: join(root, id) });
    }
  }
  const replacements = [...previous, ...staged];
  // Reject partial artifacts before modifying the candidate tree. The workflow
  // validates each network before upload and the merged tree before committing.
  for (const replacement of replacements) await requireComplete(replacement.path);
  for (const replacement of replacements) {
    const destination = join(dataRoot, replacement.id);
    await rm(destination, { recursive: true, force: true });
    await cp(replacement.path, destination, { recursive: true });
  }
  return staged.length;
}

/** Serialize verified canonical data without changing generation or validity dates. */
export async function writeHttpSnapshots(dataRoot: string): Promise<void> {
  const snapshots: { id: string; raw: Record<string, unknown> }[] = [];
  for (const id of await directories(dataRoot)) {
    const raw: Record<string, unknown> = {};
    for (const key of KEYS) {
      raw[key] = JSON.parse(await readFile(join(dataRoot, id, `${key}.json`), 'utf8'));
    }
    snapshots.push({ id, raw });
  }
  const out = join(dataRoot, '.snapshots');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const { id, raw } of snapshots) {
    await writeFile(join(out, `${id}.json`), `${JSON.stringify(raw)}\n`);
  }
  await writeFile(
    join(out, 'index.json'),
    `${JSON.stringify({
      networks: snapshots.map(({ raw }) => raw.network)
    })}\n`
  );
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const root = resolve(process.env.OPENMETRO_DATA_ROOT ?? 'data');
  if (process.argv[2] === 'seed') {
    const id = arg('--network');
    if (!id) throw new Error('seed requires --network ID');
    const restored = await seedPublishedNetwork(process.cwd(), id);
    console.log(restored ? `Restored published ${id}` : `No published ${id}; using checkout data`);
  } else if (process.argv[2] === 'merge') {
    const count = await mergePublishedData(root, arg('--previous'), arg('--artifacts'));
    console.log(`Applied ${count} complete network artifacts`);
  } else if (process.argv[2] === 'snapshots') {
    await writeHttpSnapshots(root);
    console.log(`Wrote HTTP snapshots to ${join(root, '.snapshots')}`);
  } else {
    throw new Error(
      'Usage: publish-data.ts seed --network ID | merge [--previous DIR] [--artifacts DIR] | snapshots'
    );
  }
}
