import { createClient } from "openmetro-client";

const API = (import.meta.env.VITE_API_URL as string) || window.location.origin;

export const client = createClient(API);

type ExcludeError<T> = Exclude<T, { error: string }>;

/**
 * Typed GET helper that extracts `data` from an Eden Treaty response and throws
 * on errors – drop-in replacement for the old `getJson<T>(path)` wrapper.
 */
export async function get<T>(
  res: Promise<{ data: T | null; error: unknown }>,
): Promise<ExcludeError<T>> {
  const { data, error } = await res;
  if (error) throw error;
  return data as ExcludeError<T>;
}
