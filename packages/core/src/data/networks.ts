import { readdir } from "node:fs/promises";

/** List network IDs from a data root directory (one subdir per network). */
export async function listNetworks(dataRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(dataRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}
