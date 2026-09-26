/**
 * City-agnostic parse/format helpers used by every adapter's normalize layer.
 *
 * Keep these total and conservative: they only fold source noise, never invent
 * city-specific policy (that stays in the adapter).
 */
import { readableSlug } from '../wikidata/lines.js';

/** Lowercase ASCII slug; falls back to `readableSlug` for CJK. */
export function asciiSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || readableSlug(s)
  );
}

/** Usable romanised English (Latin letters, not CJK, not the `x` placeholder). */
export function isUsableEnglish(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  if (!t || t.length < 2) return false;
  if (t.toLowerCase() === 'x') return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/[一-鿿]/.test(t)) return false;
  // Reject readableSlug hashes (`e3t0z`, `Klem6`) that look like Latin+digit tokens.
  // Allow real short codes such as T1 / T2 / T3.
  if (/^[A-Za-z]{1,4}\d[A-Za-z0-9]*$/.test(t) && !/^T\d/.test(t)) return false;
  return true;
}

/** Title-case a romanised run (`CHANHE` / `chan he` → `Chan He`). */
export function titleCaseRoman(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * AMap `sp` pinyin is CamelCase (`AoTi ZhongXin`). Reject garbled tokens
 * (生僻字 often come back as `? he`) and title-case the rest.
 */
export function pinyinToEnglish(sp: string | undefined): string | undefined {
  const t = (sp ?? '').trim();
  if (!t || !/^[A-Za-z]/.test(t) || /\?/.test(t)) return undefined;
  return titleCaseRoman(t).replace(/\s+,/g, ',');
}

/**
 * Station id slug from a romanised label, falling back to the Chinese name.
 * Prefer human-readable Latin ids when English is usable.
 */
export function stationIdFor(en: string | undefined, zh: string, pinyin?: string): string {
  const label = (en ?? '').trim();
  if (isUsableEnglish(label)) {
    const slug = label
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/['''''`']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return slug;
    return readableSlug(label);
  }
  const py = (pinyin ?? '').trim();
  if (py && /^[A-Za-z]/.test(py) && !py.includes('?')) return asciiSlug(py);
  return readableSlug(zh);
}

/** `#01A2E2` style; returns undefined for anything else. */
export function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^#/, '').trim();
  if (m.length !== 6) return undefined;
  return `#${m.toLowerCase()}`;
}

/** AMap subway `sl` field: `"lon,lat"` → `{ lon, lat }`. */
export function parseSlCoord(sl: string | undefined): { lon: number; lat: number } | undefined {
  if (!sl) return undefined;
  const [lonRaw, latRaw] = sl.split(',');
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

/** AMap subway `p` field: `"x y"` schematic pixels. */
export function parsePixel(p: string | undefined): { x: number; y: number } | undefined {
  if (!p) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(p.trim());
  if (!m) return undefined;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Fold official/AMap station-name noise so the two feeds match:
 * full-width parens, trailing 站.
 */
export function foldStationName(zh: string): string {
  return (
    zh
      .trim()
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      // T1、T2、T3 vs T1/T2/T3 — collapse list separators inside the name.
      .replace(/[/、，,]+/g, '/')
      .replace(/\s+/g, '')
      .replace(/站$/, '')
      .trim()
  );
}

/**
 * Clean a timetable cell to `HH:MM` or undefined.
 * Rejects dash placeholders and non-time text.
 */
export function cleanTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().replace('：', ':');
  if (!t || /^[-–—－]+$/.test(t)) return undefined;
  if (!/^\d{1,2}:\d{2}$/.test(t)) return undefined;
  return t;
}

/** Great-circle distance in km. SSOT is `geocode/consistency.ts`. */
export { haversineKm } from '../geocode/consistency.js';
