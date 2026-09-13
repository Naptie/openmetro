import { browser } from '$app/environment';
import * as messages from '$lib/paraglide/messages';
import { getLocale, locales, setLocale } from '$lib/paraglide/runtime';

/**
 * Reactive locale access for paraglide v2 in a fully client-rendered SPA.
 *
 * The locale is resolved eagerly (never written inside a getter — mutating
 * `$state` during a template/derived read is forbidden in Svelte 5), and
 * `setLocale(..., { reload: false })` keeps in-memory state (the map, the
 * route) alive across switches. Every component reads messages through
 * `i18n.t`, whose getter depends on the `locale` signal and re-runs
 * templates when it changes.
 */
let current: string = $state(browser ? getLocale() : 'en');

export const i18n = {
  /** Current locale, detected from the strategy chain on startup. */
  get locale(): string {
    return current;
  },
  /** Message namespace; re-evaluated reactively whenever the locale changes. */
  get t(): typeof messages {
    void current;
    return messages;
  },
  /** All configured locales. */
  get locales(): readonly string[] {
    return locales;
  },
  /** Display name of a locale, in that locale. */
  name(locale: string): string {
    return locale === 'zh' ? '中文' : 'English';
  },
  /** Switch locale in place (no reload; strategies persist it). */
  async set(locale: string): Promise<void> {
    if (locale === current) return;
    await setLocale(locale as Parameters<typeof setLocale>[0], { reload: false });
    current = locale;
    document.documentElement.lang = locale;
  }
};
