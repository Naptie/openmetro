import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '../schema/file.js';

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

/**
 * Write a canonical dataset to `data/<networkId>/`. Each entity file is
 * wrapped via `wrap`. `network.json` and the `fares.json` matrix document are
 * written as bare objects.
 */
export async function writeCanonical<
  N,
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

  await writeFile(join(outDir, 'network.json'), JSON.stringify(data.network, null, 2), 'utf-8');
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
