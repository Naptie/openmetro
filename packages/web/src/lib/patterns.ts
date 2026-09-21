/**
 * Display helpers for line patterns.
 *
 * Operators publish both directions; adapters store each alignment. Pure
 * reverse patterns are not service branches — showing them as「支线交路」
 * invents a spur that does not exist on the map.
 */

export interface PatternLike {
  id: string;
  is_primary?: boolean;
  stop_ids: string[];
  junction_stop_id?: string | null;
  extras?: Record<string, unknown> | null;
}

function extrasRole(pattern: PatternLike): string | undefined {
  const role = pattern.extras?.pattern_role;
  return typeof role === 'string' ? role : undefined;
}

/** True when `pattern.stop_ids` is exactly `primary.stop_ids` reversed. */
export function isExactReverseOf(pattern: PatternLike, primary: PatternLike): boolean {
  if (pattern.id === primary.id) return false;
  if (pattern.stop_ids.length !== primary.stop_ids.length) return false;
  const n = primary.stop_ids.length;
  for (let i = 0; i < n; i++) {
    if (pattern.stop_ids[i] !== primary.stop_ids[n - 1 - i]) return false;
  }
  return true;
}

/**
 * Patterns the UI should offer as「支线交路」/ draw as spur geometry.
 * Excludes the primary alignment and pure reverse-direction alignments.
 */
export function displayBranchPatterns<T extends PatternLike>(patterns: readonly T[]): T[] {
  const primary =
    patterns.find((p) => p.is_primary) ??
    [...patterns].sort((a, b) => b.stop_ids.length - a.stop_ids.length)[0];
  return patterns.filter((p) => {
    if (p.id === primary?.id) return false;
    const role = extrasRole(p);
    if (role === 'reverse') return false;
    if (primary && isExactReverseOf(p, primary)) return false;
    return true;
  });
}

/** Label key for a pattern tab: primary vs real branch/service variant. */
export function patternVariantKey(
  pattern: PatternLike,
  primary: PatternLike | undefined
): 'primary' | 'branch' | 'reverse' {
  if (pattern.is_primary || (primary && pattern.id === primary.id)) return 'primary';
  if (extrasRole(pattern) === 'reverse' || (primary && isExactReverseOf(pattern, primary))) {
    return 'reverse';
  }
  return 'branch';
}
