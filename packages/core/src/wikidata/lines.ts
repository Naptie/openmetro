/**
 * Derive an English display name for a metro line from its Chinese name and
 * numeric code. Used as a deterministic fallback when Wikidata lookup is
 * unavailable. Handles the common Chinese metro line-name patterns.
 */
export function deriveLineEnglishName(zhName: string, lcode?: string): string | undefined {
  // Strip a leading "地铁" prefix (subway).
  const name = zhName.replace(/^地铁/, '');
  const lc = (lcode ?? '').replace(/^0+/, '');

  // Special named lines (not plain numbered).
  const special: Record<string, string> = {
    S1线: 'S1 Line',
    西郊线: 'Western Suburban Line',
    房山线: 'Fangshan Line',
    昌平线: 'Changping Line',
    亦庄线: 'Yizhuang Line',
    燕房线: 'Yanfang Line',
    首都机场线: 'Capital Airport Express',
    大兴机场线: 'Daxing Airport Express',
    亦庄T1线: 'Yizhuang T1 Line',
    浦江线: 'Pujiang Line',
    市域机场线: 'Airport Link Line'
  };
  if (special[name]) return special[name];

  // Lines named "<N>号线" or "<N>号线<词>" (e.g. 1号线八通线, 4号线大兴线).
  const numbered = /^(\d+)号线(.*)$/.exec(name);
  if (numbered) {
    const num = numbered[1];
    const suffix = numbered[2];
    const base = `Line ${num}`;
    if (!suffix) return base;
    // Map common suffix words.
    const suffixEn: Record<string, string> = {
      大兴线: 'Daxing',
      八通线: 'Batong',
      知识城: 'Knowledge City'
    };
    const sfx = suffixEn[suffix];
    return sfx ? `${base} (${sfx})` : `${base} ${suffix}`;
  }

  // Just a number (sometimes passes as e.g. "1").
  if (/^\d+$/.test(name)) return lc ? `Line ${lc}` : undefined;

  return undefined;
}

/**
 * Produce a clean, ASCII, unique slug for a line, preferring the official line
 * code when it is ASCII (e.g. "1", "GF", "THZ1"), otherwise the English name.
 * This avoids hex/jibberish fallbacks for lines whose display code is CJK
 * (e.g. Guangzhou intercity lines).
 */
export function lineSlug(code: string | undefined, enName: string | undefined): string {
  const asciiCode = code?.trim();
  if (asciiCode && /^[A-Za-z0-9-]+$/.test(asciiCode)) {
    return asciiCode.toLowerCase().replace(/^0+(?=\d)/, '');
  }
  const en = enName?.trim();
  if (en && /^[A-Za-z0-9 -]+$/.test(en)) {
    return en
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  // Last resort: encode any remaining CJK as a stable hex token (rare).
  return [...Buffer.from(code ?? en ?? 'line', 'utf-8')].map((b) => b.toString(16)).join('');
}

/**
 * Strip a Guangzhou loop-line **direction** annotation from a destination name.
 *
 * Source terminals look like `上涌(内环-全程)` / `大塘(外环-终点龙潭)` — the
 * parenthetical is service direction, not part of the station name.
 *
 * Identity parentheses are **kept**: `竹料（城际）`, `万胜围（有轨）`,
 * `机场北（T2）` are distinct stations from `竹料` / `万胜围` / `机场北`.
 */
export function stripDirectionAnnotation(name: string): string {
  return name.replace(/[（(]\s*(?:内环|外环)[^)）]*[)）]/g, '').trim();
}

/**
 * Slug that never falls back to long hex jibberish. ASCII input is slugged
 * normally; non-ASCII input is reduced to a compact base-36 hash. Use the
 * English name (via enByZh) whenever possible so the result is human-readable.
 */
export function readableSlug(input: string): string {
  const s = input.trim();
  if (/^[A-Za-z0-9 -]+$/.test(s)) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  // Compact stable hash (base-36) for non-ASCII — no long hex strings.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
