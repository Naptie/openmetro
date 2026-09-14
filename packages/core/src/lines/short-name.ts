/**
 * Compact display code (`short_name`) derivation shared by the adapters.
 *
 * Deliberately conservative: only codes literally present in the line name
 * are extracted; anything else returns `undefined` — never guess. Networks
 * whose sources publish an official display code should prefer that over
 * derivation.
 */

/**
 * Derive a line's compact display code from its Chinese name.
 *
 * Handled patterns: leading digits before `号线` (`2号线`, including compound
 * names that continue past it), an `S`-code forming the whole name (`S1线` →
 * `S1`), a tram-style `T` code (`T1`), and the literal `APM`. Names without
 * an extractable code → `undefined`.
 */
export function deriveLineShortName(name: string): string | undefined {
  const numbered = /^(\d+)号线/.exec(name);
  if (numbered) return numbered[1];
  const sCode = /^S(\d+)线$/.exec(name);
  if (sCode) return `S${sCode[1]}`;
  // The T-code must not be glued to another ASCII token.
  const tCode = /(?:^|[^A-Za-z0-9])T(\d+)/.exec(name);
  if (tCode) return `T${tCode[1]}`;
  if (/^APM线?$/.test(name)) return 'APM';
  return undefined;
}

/**
 * Resolve a line's mandatory `short_name`.
 *
 * Prefers an official short label published by the source (Beijing's `slb`,
 * Guangzhou's `lineShowCode`); otherwise derives a code from the name; and as
 * a last resort falls back to the line's own name so the field is never empty.
 * The fallback keeps the contract total without inventing a code that the
 * operator does not publish.
 */
export function resolveLineShortName(name: string, officialShortLabel?: string | null): string {
  const official = officialShortLabel?.trim();
  if (official) return official;
  return deriveLineShortName(name) ?? name.trim();
}
