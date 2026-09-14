import type { ApiLineMode as LineMode, ApiLineStatus as LineStatus } from 'openmetro-client';

/**
 * Loosest input contract for localized entity names — every API entity's
 * `names` field (see openmetro-client) is assignable to this.
 */
interface LocalizedNames {
  zh?: string;
  en?: string;
}

/** Localized display name for an entity with per-locale names. */
export function localizedName(
  names: LocalizedNames | undefined | null,
  fallback: string,
  locale: string
): string {
  if (locale === 'zh') return names?.zh ?? fallback;
  return names?.en ?? fallback;
}

/** English display name for a network. */
export function networkEnName(meta: { names: { en: string } }): string {
  return meta.names.en;
}

/** Localized network name. */
export function networkName(
  meta: { name: string; names: { zh: string; en: string } },
  locale: string
): string {
  if (locale === 'zh') return meta.name;
  return networkEnName(meta);
}

/** "1h 05m" / "42 min" (en) or "1小时05分" / "42分钟" (zh). */
export function formatDuration(seconds: number, locale: string): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (locale === 'zh') {
    return h > 0 ? `${h}小时${String(m).padStart(2, '0')}分` : `${totalMinutes}分钟`;
  }
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${totalMinutes} min`;
}

/**
 * Status → message key. Keyed by the schema-derived LineStatus union so a new
 * status in packages/core/src/schema/line.ts fails typecheck here until it is
 * handled. Unknown runtime values fall back to status_other.
 */
const LINE_STATUS_KEYS: Record<LineStatus, string> = {
  operating: 'status_operating',
  partially_operating: 'status_partially_operating',
  under_construction: 'status_under_construction',
  planned: 'status_planned',
  closed: 'status_closed'
};

export function lineStatusKey(status: string | undefined): string {
  return (status && LINE_STATUS_KEYS[status as LineStatus]) || 'status_other';
}

/**
 * Mode → message key. Keyed by the schema-derived LineMode union (see the
 * note on LINE_STATUS_KEYS).
 */
const LINE_MODE_KEYS: Record<LineMode, string> = {
  metro: 'line_mode_metro',
  suburban_rail: 'line_mode_suburban_rail',
  light_rail: 'line_mode_light_rail',
  tram: 'line_mode_tram',
  monorail: 'line_mode_monorail',
  airport_express: 'line_mode_airport_express',
  other: 'line_mode_other'
};

/** Map a raw line mode to its message key (unknown modes fall back to line_mode_other). */
export function lineModeKey(mode: string | undefined): string {
  return (mode && LINE_MODE_KEYS[mode as LineMode]) || 'line_mode_other';
}
