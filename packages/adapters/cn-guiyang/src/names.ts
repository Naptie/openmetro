/**
 * Station-name normalisation for cn-guiyang.
 *
 * The operator publishes the same stations under several spellings:
 *
 * | Source | Example |
 * |---|---|
 * | inquiry page | `东风（贵黔医院）`, `窦官站`, `白云北路站` |
 * | planner API | `东风(贵黔医院)`, `北京路站(C口)`, `多彩贵州城` |
 * | AMap Subway | `东风(贵黔医院)`, `窦官`, `贵安站` |
 * | official network map | `东风(贵黔医院)`, `窦官`, `贵安` |
 *
 * Three normalisations are therefore applied to every source:
 *
 * 1. full-width parentheses are folded to half-width (the operator's own map
 *    legend and AMap both use half-width);
 * 2. an **entrance marker** the planner appends (`(C口)`, `(A2口)`, …) is
 *    dropped — but a genuine name alias (`(贵黔医院)`, `(省中医院)`,
 *    `(省委党校)`) is kept;
 * 3. a trailing `站` is dropped unless the name is a real station name that
 *    ends in one (`贵阳北站`, `贵阳火车站`, `花溪南站`).
 *
 * One **operator-side naming error** is corrected explicitly: the planner
 * database labels 2 号线's 小碧站 as `多彩贵州城`, which is the adjacent
 * shopping complex, not the station. The operator's own network map, their
 * 2025-08-29 opening announcement for 小碧站 A 出入口, AMap, Baidu Maps and
 * both Chinese encyclopedias all use `小碧`.
 */

/**
 * Names that legitimately end in `站` — stripping the suffix would rename the
 * station (`贵阳北站` → `贵阳北`).
 */
const KEEP_STATION_SUFFIX = new Set(['贵阳北站', '贵阳火车站', '花溪南站']);

/**
 * Operator-side corrections: the name the source uses → the canonical name.
 *
 * `多彩贵州城` is the commercial complex next to 小碧站; the operator's
 * planner and their group-level 乘车指南 page use it where the network map
 * says `小碧`.
 */
const NAME_OVERRIDES: Record<string, string> = {
  多彩贵州城: '小碧'
};

/** An entrance marker the planner appends to a station label. */
const ENTRANCE_SUFFIX = /\((?:[A-Z]\d*口|出口|入口)\)$/;

/** Fold one raw source label into the canonical Chinese station name. */
export function guiyangStationName(raw: string): string {
  let name = raw.trim();
  if (!name) return name;

  // 1. full-width parentheses → half-width
  name = name.replace(/（/g, '(').replace(/）/g, ')');

  // 2. entrance marker (but never a real name alias)
  name = name.replace(ENTRANCE_SUFFIX, '').trim();

  // 3. trailing 站 — before the override, because the planner spells the
  //    misnamed station `多彩贵州城站` while the page spells it `多彩贵州城`.
  if (name.endsWith('站') && !KEEP_STATION_SUFFIX.has(name)) {
    name = name.slice(0, -1);
  }

  // 4. operator-side corrections
  name = NAME_OVERRIDES[name] ?? name;

  return name;
}

/**
 * Fold a name for matching between two sources.
 *
 * Same rules as {@link guiyangStationName} but the operator-side override is
 * *not* applied, so a source that spells the station `多彩贵州城` still folds
 * onto the same key as the sources that spell it `小碧`.
 */
export function foldGuiyangStationName(raw: string): string {
  let name = raw.trim();
  if (!name) return name;
  name = name.replace(/（/g, '(').replace(/）/g, ')');
  name = name.replace(ENTRANCE_SUFFIX, '').trim();
  if (name.endsWith('站') && !KEEP_STATION_SUFFIX.has(name)) {
    name = name.slice(0, -1);
  }
  return name;
}
