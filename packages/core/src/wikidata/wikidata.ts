const SEARCH_URL = 'https://www.wikidata.org/w/api.php';
const ENTITY_URL = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'openmetro/0.1 (data enrichment)';
const WIKIDATA_TIMEOUT_MS = 4000;

export interface WikidataNames {
  zh?: string;
  en?: string;
  /** The matched Wikidata entity id (QID). */
  qid?: string;
}

interface SearchResponse {
  search?: { id: string; label?: string; description?: string }[];
}

interface EntityResponse {
  entities?: Record<string, { labels?: Record<string, { value: string }> }>;
}

const wbRequest = async (url: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIKIDATA_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`wikidata ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Search Wikidata by a label and return candidate QIDs (with the matched
 * label). Used to resolve a Chinese station/line name to a Wikidata entity.
 */
export async function searchWikidata(
  label: string,
  language = 'zh'
): Promise<{ id: string; label?: string }[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', label);
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '10');
  const data = (await wbRequest(url.toString())) as SearchResponse;
  return (data.search ?? []).map((s) => ({ id: s.id, label: s.label }));
}

/**
 * Fetch multilingual labels for a batch of QIDs. Returns `{ zh, en }` when both
 * (or either) label languages are present.
 */
export async function fetchEntityLabels(qid: string): Promise<WikidataNames> {
  const url = new URL(ENTITY_URL);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', qid);
  url.searchParams.set('props', 'labels');
  url.searchParams.set('languages', 'zh|en');
  url.searchParams.set('format', 'json');
  const data = (await wbRequest(url.toString())) as EntityResponse;
  const entity = data.entities?.[qid];
  if (!entity) return { qid };
  const zh = entity.labels?.zh?.value;
  const en = entity.labels?.en?.value;
  return { zh, en, qid };
}

/**
 * Resolve multilingual names for a label via Wikidata, with a best-effort
 * match: search, then fetch labels for the first candidate. Returns `null` on
 * failure (network, no match) so callers can fall back.
 */
export type WikidataLookupResult =
  | { status: 'ok'; names: WikidataNames }
  | { status: 'no_match' }
  | { status: 'unreachable' };

export async function lookupWikidata(label: string): Promise<WikidataLookupResult> {
  const queries = [label];
  if (!label.endsWith('站') && !label.endsWith('線') && !label.endsWith('线')) {
    queries.push(`${label}站`);
    queries.push(`${label} metro station`);
  }
  try {
    for (const q of queries) {
      const results = await searchWikidata(q);
      if (results.length === 0) continue;
      // Prefer an exact/站-suffixed label match over a loose first hit.
      const exact =
        results.find((r) => r.label === label) ??
        results.find((r) => r.label === `${label}站`) ??
        results.find((r) => r.label === `${label} station`) ??
        results[0];
      const names = await fetchEntityLabels(exact.id);
      // An English label alone is enough — station entities often only label zh+en.
      if (names.en) return { status: 'ok', names: { ...names, zh: names.zh ?? label } };
    }
    return { status: 'no_match' };
  } catch {
    return { status: 'unreachable' };
  }
}

/**
 * Fill missing English names using Wikidata. For each entry without an English
 * name, look up its Chinese label. Returns new entries (does not mutate
 * inputs). On failure the entry is left unchanged (no en), so callers should
 * provide a deterministic fallback.
 */

export async function fillMissingEnglish<T extends { names: { zh: string; en?: string } }>(
  entries: T[],
  opts: {
    getLabel: (entry: T) => string;
    onLookup?: (label: string, qid?: string) => void;
  }
): Promise<T[]> {
  const result: T[] = [];
  let unreachable = false;
  for (const entry of entries) {
    if (unreachable) {
      result.push(entry);
      continue;
    }
    if (entry.names.en?.trim()) {
      result.push(entry);
      continue;
    }
    const label = opts.getLabel(entry);
    const res = await lookupWikidata(label);
    if (res.status === 'unreachable') {
      unreachable = true;
      result.push(entry);
      continue;
    }
    const names = res.status === 'ok' ? res.names : {};
    opts.onLookup?.(label, names.qid);
    if (names.en) result.push({ ...entry, names: { zh: entry.names.zh, en: names.en } });
    else result.push(entry);
  }
  return result;
}

/**
 * Station English names via Wikidata (single policy for every adapter).
 *
 * Fills empty `names.en` from Wikidata, then normalises Wikidata's
 * " Foo station" suffix when the Chinese label does not end in 站.
 * Returns `{ stations, requested, filled }`.
 */
export async function fillStationEnglishNames<
  T extends { names: { zh: string; en?: string }; name?: string }
>(stations: T[]): Promise<{ stations: T[]; requested: number; filled: number }> {
  const requested = stations.filter((s) => !s.names.en?.trim()).length;
  const filledRaw = await fillMissingEnglish(stations, {
    getLabel: (s) => s.names.zh || s.name || ''
  });
  const out = filledRaw.map((s) => {
    const en = s.names.en?.trim();
    const zh = s.names.zh || s.name || '';
    if (en && / station$/i.test(en) && zh && !zh.endsWith('站')) {
      return { ...s, names: { zh: s.names.zh, en: en.replace(/ station$/i, '') } };
    }
    return s;
  });
  // Deterministic last resort: AMap pinyin from extras. Never copy Chinese
  // into names.en (verify requires a romanised label).
  const withFallback = out.map((s) => {
    const en = s.names.en?.trim();
    if (en) return s;
    const extras = (s as { extras?: Record<string, unknown> }).extras;
    const py = typeof extras?.pinyin === 'string' ? extras.pinyin.trim() : '';
    if (py && /^[A-Za-z]/.test(py)) {
      return { ...s, names: { zh: s.names.zh, en: titleCaseRoman(py) } };
    }
    return s;
  });
  const filled = requested - withFallback.filter((s) => !s.names.en?.trim()).length;
  return { stations: withFallback, requested, filled };
}

import { titleCaseRoman } from '../adapter/text.js';
import { deriveLineEnglishName } from './lines.js';

/**
 * Resolve an English name for a line: try Wikidata first, then fall back to a
 * deterministic derivation from the Chinese name + line code. This guarantees
 * an English name even when Wikidata is unreachable.
 */
export async function resolveLineEnglishName(
  zhName: string,
  lcode?: string
): Promise<{ en: string; source: 'wikidata' | 'derived' }> {
  const res = await lookupWikidata(zhName);
  if (res.status === 'ok' && res.names.en) return { en: res.names.en, source: 'wikidata' };
  const derived = deriveLineEnglishName(zhName, lcode);
  if (derived) return { en: derived, source: 'derived' };
  return { en: zhName, source: 'derived' };
}

import type { LineEncoded } from '../schema/index.js';

/**
 * Enrich line English names from Wikidata. For lines whose English name was
 * derived (not from the source), try a Wikidata lookup and upgrade the name
 * when found. Lines already carrying a source English name are left unchanged.
 * Uses a circuit breaker: once Wikidata is unreachable, remaining lines are
 * left as-is (so a network failure doesn't hang or churn the run).
 */
export async function enrichLineNamesFromWikidata(
  lines: LineEncoded[],
  opts: {
    getEnglishLookupLabel: (line: LineEncoded) => string;
    onLookup?: (label: string, qid?: string) => void;
  }
): Promise<LineEncoded[]> {
  const out: LineEncoded[] = [];
  let unreachable = false;
  for (const line of lines) {
    if (unreachable) {
      out.push(line);
      continue;
    }
    const source = (line.extras as { names_source?: string } | undefined)?.names_source;
    if (source === 'source') {
      out.push(line);
      continue;
    }
    const label = opts.getEnglishLookupLabel(line);
    const res = await lookupWikidata(label);
    if (res.status === 'unreachable') {
      unreachable = true;
      out.push(line);
      continue;
    }
    const names = res.status === 'ok' ? res.names : {};
    opts.onLookup?.(label, names.qid);
    if (names.en && names.en !== line.names.en) {
      out.push({
        ...line,
        names: { zh: line.names.zh, en: names.en },
        extras: { ...(line.extras ?? {}), names_source: 'wikidata' }
      });
    } else {
      out.push(line);
    }
  }
  return out;
}
