import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '../schema/file.js';
import type { FareMatrixEncoded } from '../schema/index.js';
import { computeNetworkQuality, type QualityInput } from './quality.js';

export interface CanonicalFile<T> {
  $schema: string;
  schema_version: string;
  network_id: string;
  generated_at: string;
  source: unknown[];
  records: T[];
}

/**
 * Wrap records as a canonical entity file. `documentType` is the city-agnostic
 * document name (`lines`, `stations`, …) that names the published JSON Schema.
 */
export function wrap<T>(networkId: string, documentType: string, records: T[]): CanonicalFile<T> {
  return {
    $schema: entitySchemaUrl(documentType),
    schema_version: '1.0',
    network_id: networkId,
    generated_at: new Date().toISOString(),
    source: [],
    records
  };
}

/** Sort records by `id` for deterministic file output. */
function sorted<A extends { id: string }>(records: A[]): A[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function loadExistingFares(outDir: string): Promise<FareMatrixEncoded | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(outDir, 'fares.json'), 'utf-8'));
    return raw as FareMatrixEncoded;
  } catch {
    return undefined;
  }
}

/**
 * Write a canonical dataset to `data/<networkId>/`. Each entity file is
 * wrapped via `wrap`. `network.json` and the `fares.json` matrix document are
 * written as bare objects.
 *
 * `network.quality` is recomputed from the records being written (and the
 * on-disk fares matrix when present) so precision/coverage cannot drift.
 */
export async function writeCanonical<
  N extends Record<string, unknown>,
  L extends { id: string },
  S extends { id: string },
  St extends { id: string },
  P extends { id: string },
  Se extends { id: string },
  T extends { id: string },
  Tm extends { id: string },
  F
>(
  outDir: string,
  networkId: string,
  data: {
    network: N;
    lines: L[];
    stations: S[];
    stops: St[];
    patterns?: P[];
    segments: Se[];
    transfers: T[];
    timetables?: Tm[];
    /** A complete `FareMatrix` document (see `schema/fare.ts`). */
    fares?: F;
  }
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const w = <A>(documentType: string, records: A[]) =>
    writeFile(
      join(outDir, `${documentType}.json`),
      JSON.stringify(wrap(networkId, documentType, records), null, 2),
      'utf-8'
    );

  const faresDoc =
    (data.fares as FareMatrixEncoded | undefined) ?? (await loadExistingFares(outDir));
  const quality = computeNetworkQuality({
    lines: data.lines as QualityInput['lines'],
    stations: data.stations as QualityInput['stations'],
    stops: data.stops as QualityInput['stops'],
    segments: data.segments as QualityInput['segments'],
    transfers: data.transfers as QualityInput['transfers'],
    timetables: (data.timetables ?? []) as QualityInput['timetables'],
    fares: faresDoc
  });
  const networkDoc = { ...data.network, quality };

  await writeFile(join(outDir, 'network.json'), JSON.stringify(networkDoc, null, 2), 'utf-8');
  await Promise.all([
    w('lines', sorted(data.lines)),
    w('stations', sorted(data.stations)),
    w('stops', sorted(data.stops)),
    data.patterns ? w('patterns', sorted(data.patterns)) : Promise.resolve(),
    w('segments', sorted(data.segments)),
    w('transfers', sorted(data.transfers)),
    data.timetables ? w('timetables', sorted(data.timetables)) : Promise.resolve()
  ]);
  if (data.fares) {
    await writeFile(join(outDir, 'fares.json'), JSON.stringify(data.fares, null, 2), 'utf-8');
  }
}
