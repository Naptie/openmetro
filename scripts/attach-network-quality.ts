/**
 * One-off: attach network.quality from existing canonical records.
 * Usage: bun run scripts/attach-network-quality.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeNetworkQuality } from '../packages/core/src/data/quality.js';

const ROOT = process.cwd();
const CITIES = ['cn-bj', 'cn-sh', 'cn-gz'];

async function records(city: string, file: string): Promise<unknown[]> {
  return JSON.parse(await readFile(join(ROOT, 'data', city, file), 'utf-8')).records ?? [];
}

for (const city of CITIES) {
  const dir = join(ROOT, 'data', city);
  const lines = await records(city, 'lines.json');
  const stations = await records(city, 'stations.json');
  const stops = await records(city, 'stops.json');
  const segments = await records(city, 'segments.json');
  const transfers = await records(city, 'transfers.json');
  const timetables = await records(city, 'timetables.json');
  let fares: { fares?: (number | null)[][] } | undefined;
  try {
    fares = JSON.parse(await readFile(join(dir, 'fares.json'), 'utf-8'));
  } catch {
    fares = undefined;
  }
  const networkPath = join(dir, 'network.json');
  const network = JSON.parse(await readFile(networkPath, 'utf-8'));
  const quality = computeNetworkQuality({
    lines: lines as { id: string; mode: string }[],
    stations: stations as never,
    stops: stops as never,
    segments: segments as never,
    transfers: transfers as never,
    timetables: timetables as never,
    fares
  });
  await writeFile(networkPath, `${JSON.stringify({ ...network, quality }, null, 2)}\n`, 'utf-8');
  console.log(city, JSON.stringify(quality, null, 2));
}
