/**
 * Shared station-name utilities.
 *
 * `foldRareCharacters` folds decomposed rare CJK characters to their single
 * codepoint form so names from different sources (OSM, AMap, official feeds)
 * match. City-specific fold forms are supplied by adapters; the core ships
 * none, so it stays city-agnostic.
 */

/**
 * Fold decomposed rare characters to the single-codepoint form using the
 * supplied city-specific forms. `foldRareCharacters('虫雷 岗', [['虫雷', '𧒽']])`
 * → `'𧒽岗'`; with no forms it is a no-op.
 */
export function foldRareCharacters(
  name: string,
  forms: readonly (readonly [string, string])[] = []
): string {
  let out = name;
  for (const [from, to] of forms) {
    out = out.split(`${from} `).join(to);
    out = out.split(from).join(to);
  }
  return out;
}
