import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CanonicalFile<T> {
  $schema: string;
  schema_version: string;
  network_id: string;
  generated_at: string;
  source: unknown[];
  records: T[];
}

export function wrap<T>(networkId: string, records: T[]): CanonicalFile<T> {
  return {
    $schema: `https://raw.githubusercontent.com/openmetro/schemas/v1/${networkId}.schema.json`,
    schema_version: "1.0",
    network_id: networkId,
    generated_at: new Date().toISOString(),
    source: [],
    records,
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
  F,
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
  },
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const w = <A>(name: string, records: A[]) =>
    writeFile(join(outDir, name), JSON.stringify(wrap(networkId, records), null, 2), "utf-8");

  await writeFile(join(outDir, "network.json"), JSON.stringify(data.network, null, 2), "utf-8");
  await w("lines.json", sorted(data.lines));
  await w("stations.json", sorted(data.stations));
  await w("stops.json", sorted(data.stops));
  if (data.patterns) await w("patterns.json", sorted(data.patterns));
  await w("segments.json", sorted(data.segments));
  await w("transfers.json", sorted(data.transfers));
  if (data.timetables) await w("timetables.json", sorted(data.timetables));
  if (data.fares) {
    await writeFile(join(outDir, "fares.json"), JSON.stringify(data.fares, null, 2), "utf-8");
  }
}
