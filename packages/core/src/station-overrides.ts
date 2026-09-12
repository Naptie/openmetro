/**
 * Central, hand-maintained station name / service-status overrides.
 *
 * Keep one-off corrections that official feeds get wrong (or omit) here —
 * not scattered through city adapters.
 */

/**
 * Rare CJK characters that some sources emit as two-character decompositions.
 * Official GZMTR text writes 𧒽岗 as "虫雷 岗"; OSM/AMap use 𧒽岗.
 */
const RARE_CHAR_FORMS: readonly (readonly [string, string])[] = [["虫雷", "𧒽"]];

/**
 * Fold decomposed rare characters to the single-codepoint form.
 * `"虫雷 岗"` → `"𧒽岗"`; `"𧒽岗"` is unchanged.
 */
export function foldRareCharacters(name: string): string {
  let out = name;
  for (const [from, to] of RARE_CHAR_FORMS) {
    out = out.split(`${from} `).join(to);
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Stations the official map/timetable feed still lists (sometimes even with
 * times) but which are **not in passenger service**.
 *
 * Keyed by Chinese display name after `foldRareCharacters`.
 */
const OUT_OF_SERVICE_STATIONS: ReadonlySet<string> = new Set([
  // Beijing Yizhuang T1 — appears on the official map; passenger service postponed.
  "老观里",
]);

/** True when a Chinese station name is forced to `out_of_service`. */
export function isForcedOutOfService(zhName: string): boolean {
  return OUT_OF_SERVICE_STATIONS.has(foldRareCharacters(zhName.trim()));
}
