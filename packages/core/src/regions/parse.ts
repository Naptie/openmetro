import type { FlatRegion, RegionIndex } from './types.js';

/**
 * Minimal RFC4180 CSV row split (quotes + escaped quotes). Enough for
 * worldwide-regions `regions-flat.csv`.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseJsonField<T>(raw: string): T | null {
  const t = raw.trim();
  if (!t) return null;
  return JSON.parse(t) as T;
}

function parseNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `regions-flat.csv` into an index.
 *
 * Only `country` / `province` / `city` rows are kept: city metadata needs the
 * city record plus its ancestor chain. Dropping county/street keeps memory
 * bounded even though the release CSV is ~90MB.
 */
export function parseRegionsCsv(text: string): RegionIndex {
  const index: RegionIndex = new Map();
  let start = 0;
  if (text.charCodeAt(0) === 0xfeff) start = 1;
  let offset = start;
  let header: string[] | undefined;
  while (offset < text.length) {
    let end = text.indexOf('\n', offset);
    if (end < 0) end = text.length;
    const line = text.slice(offset, end).replace(/\r$/, '');
    offset = end + 1;
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (!header) {
      header = cols;
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? '']));
    const level = row.level?.trim();
    if (level !== 'country' && level !== 'province' && level !== 'city') continue;
    const id = row.id?.trim();
    if (!id) continue;
    const parentId = row.parentId?.trim();
    const name = parseJsonField<Record<string, string>>(row.name) ?? {};
    const location = parseJsonField<FlatRegion['location']>(row.location);
    index.set(id, {
      id,
      parentId: parentId || null,
      level,
      name,
      population: parseNumber(row.population),
      area: parseNumber(row.area),
      location: location && typeof location === 'object' ? location : null
    });
  }
  return index;
}
