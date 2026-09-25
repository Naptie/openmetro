import {
  deriveLineEnglishName,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc, ZhengzhouSources } from './fetch.js';

const NETWORK_ID = 'cn-zhengzhou';
const ZZ_SOURCE = 'zzmetro-api';
const ZZ_HOURS_SOURCE = 'zzmetro-operating-hours';
const AMAP_SOURCE = 'amap-subway-4101';

export interface ZzLineConfig {
  /** Official API line key (`1`, `9` for 城郊线, `17` for 郑许线). */
  key: string;
  name: string;
  short: string;
  /** Stable ASCII slug used in line/stop ids. */
  slug: string;
  mode: 'metro' | 'suburban_rail';
  loop?: boolean;
}

/**
 * Official line registry. `key` matches `api.zzmetro.com` line ids;
 * `short` is the map badge (`城郊` / `郑许` for non-numbered lines).
 */
export const LINE_CONFIGS: ZzLineConfig[] = [
  { key: '1', name: '1号线', short: '1', slug: '1', mode: 'metro' },
  { key: '2', name: '2号线', short: '2', slug: '2', mode: 'metro' },
  { key: '3', name: '3号线', short: '3', slug: '3', mode: 'metro' },
  { key: '4', name: '4号线', short: '4', slug: '4', mode: 'metro' },
  { key: '5', name: '5号线', short: '5', slug: '5', mode: 'metro', loop: true },
  { key: '6', name: '6号线', short: '6', slug: '6', mode: 'metro' },
  { key: '7', name: '7号线', short: '7', slug: '7', mode: 'metro' },
  { key: '8', name: '8号线', short: '8', slug: '8', mode: 'metro' },
  { key: '9', name: '城郊线', short: '城郊', slug: 'chengjiao', mode: 'metro' },
  { key: '10', name: '10号线', short: '10', slug: '10', mode: 'metro' },
  { key: '12', name: '12号线', short: '12', slug: '12', mode: 'metro' },
  { key: '14', name: '14号线', short: '14', slug: '14', mode: 'metro' },
  { key: '17', name: '郑许线', short: '郑许', slug: 'zhengxu', mode: 'suburban_rail' }
];

export interface ZhengzhouCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coords keyed by station id (and folded zh name). */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^#/, '').trim();
  if (m.length !== 6) return undefined;
  return `#${m.toLowerCase()}`;
}

function parseSlCoord(sl: string | undefined): { lon: number; lat: number } | undefined {
  if (!sl) return undefined;
  const [lonRaw, latRaw] = sl.split(',');
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

function parsePixel(p: string | undefined): { x: number; y: number } | undefined {
  if (!p) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(p.trim());
  if (!m) return undefined;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Official/AMap names may differ by hospital co-names, parentheticals, or 站. */
export function foldStationName(zh: string): string {
  return (
    zh
      .trim()
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      // AMap appends co-named facilities: 五一公园·市中医院 → 五一公园
      .split('·')[0]!
      .replace(/\([^)]*\)/g, '')
      .replace(/站$/, '')
      .trim()
  );
}

/**
 * AMap `sp` is CamelCase pinyin. Title-case it so station English names / ids
 * stay human-readable when `en` / `multilang.n.en` is blank or ALL-CAPS.
 */
function pinyinToEnglish(sp: string | undefined): string | undefined {
  const t = (sp ?? '').trim();
  if (!t || !/^[A-Za-z]/.test(t)) return undefined;
  return t
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ')
    .replace(/\s+,/g, ',');
}

function titleCaseEn(en: string | undefined): string | undefined {
  const t = (en ?? '').trim();
  if (!t || !/^[A-Za-z]/.test(t)) return undefined;
  // Prefer AMap's sentence-case English when mixed; keep known acronyms.
  if (/[a-z]/.test(t)) return t;
  return t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Split AMap CamelCase pinyin into syllables: `WuYi` → `Wu`, `Yi`. */
function camelSyllables(token: string): string[] {
  return token.match(/[A-Z][a-z]*/g) ?? [token];
}

function countCjk(s: string): number {
  return [...s].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
}

/**
 * Pinyin for the **primary** segment only (before `·`).
 * `RenMin Lu HeNan ZhongYiYi FuYuan` + `人民路` → `Renmin Lu`.
 */
function pinyinOfPrimary(sp: string | undefined, primaryZh: string): string | undefined {
  const t = (sp ?? '').trim();
  if (!t || !/^[A-Za-z]/.test(t)) return undefined;
  const nChars = countCjk(primaryZh);
  if (nChars <= 0) return pinyinToEnglish(t);
  const tokens = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let n = 0;
  for (const token of tokens) {
    if (n >= nChars) break;
    const syllables = camelSyllables(token);
    if (n + syllables.length <= nChars) {
      out.push(token);
      n += syllables.length;
    } else {
      out.push(syllables.slice(0, nChars - n).join(''));
      n = nChars;
    }
  }
  return pinyinToEnglish(out.join(' ') || t);
}

/** English phrase that describes only the primary place, not the co-name. */
function stripEnglishCoName(en: string): string {
  // "S. 4th Ring Road (Zhengzhou Airport Railway Station)" → "S. 4th Ring Road"
  let s = en.split(/\(/)[0] ?? en;
  // "Renmin Road The First Affiliated Hospital of ..." → "Renmin Road"
  s =
    s.split(
      /\s+(?:The|Of|For)\s+|\s+Hospital\b|\s+University\b|\s+Center\b|\s+Centre\b|\s+Clinic\b/i
    )[0] ?? s;
  return s.replace(/[\s,/]+$/, '').trim() || en.trim();
}

export interface StationNameParts {
  /** Primary Chinese name without trailing 站 / co-name. */
  primaryZh: string;
  /** Co-named facility (hospital etc.), if any. */
  coName?: string;
  /** Full AMap display name. */
  amapName?: string;
  /** Full AMap English (may include co-name). */
  amapEnFull?: string;
  /** Primary English for `names.en` / id. */
  en: string;
}

/**
 * Extract the primary station name from AMap's co-named display strings.
 *
 * Official feeds use `人民路站`; AMap publishes `人民路·河南中医一附院` with a
 * full hospital English. Canonical `names.en` / ids must stay the **place**
 * (`Renmin Lu` / `Renminlu` style), not the sponsoring facility.
 */
export function extractStationNames(amap: AmapStation | undefined, zhRaw: string): StationNameParts {
  const zh = zhRaw.trim();
  const amapName = String(amap?.n ?? '').trim() || undefined;
  const amapEnFull =
    String(amap?.multilang?.n?.en ?? '').trim() ||
    String(amap?.en ?? '').trim() ||
    undefined;
  const primaryZh = foldStationName(zh) || (amapName ? foldStationName(amapName) : zh);
  const amapPrimary = amapName ? foldStationName(amapName) : '';
  const midDotCo =
    amapName && amapName.includes('·') ? amapName.split('·').slice(1).join('·').trim() : undefined;
  const parenCo = amapName ? (/\(([^)]+)\)/.exec(amapName)?.[1]?.trim() ?? undefined) : undefined;
  const coName = midDotCo ?? parenCo;

  const isCoNamed =
    Boolean(coName) || Boolean(amapEnFull && (/\//.test(amapEnFull) || /\(/.test(amapEnFull)));

  if (isCoNamed) {
    // 1) pinyin of primary Chinese segment (stable across ALL-CAPS / translated EN)
    const py = pinyinOfPrimary(amap?.sp, primaryZh || amapPrimary);
    if (py) {
      return {
        primaryZh: primaryZh || zh,
        coName,
        amapName,
        amapEnFull,
        en: py
      };
    }
    // 2) AMap slash form: "WUYIGONGYUAN / SHIZHONGYIYUAN" → left side
    if (amapEnFull && amapEnFull.includes('/')) {
      const left = amapEnFull.split('/')[0]!.trim();
      const en = titleCaseEn(left) || stripEnglishCoName(left);
      return { primaryZh: primaryZh || zh, coName, amapName, amapEnFull, en };
    }
    // 3) translated long form: cut at hospital/university/…
    if (amapEnFull) {
      return {
        primaryZh: primaryZh || zh,
        coName,
        amapName,
        amapEnFull,
        en: stripEnglishCoName(titleCaseEn(amapEnFull) ?? amapEnFull)
      };
    }
  }

  // Not co-named: keep previous behaviour (AMap EN → pinyin → zh).
  const multilang = titleCaseEn(amapEnFull);
  if (multilang) return { primaryZh: primaryZh || zh, amapName, amapEnFull, en: multilang };
  const en = titleCaseEn(amap?.en);
  if (en) return { primaryZh: primaryZh || zh, amapName, amapEnFull, en };
  const pinyin = pinyinToEnglish(amap?.sp);
  if (pinyin) return { primaryZh: primaryZh || zh, amapName, amapEnFull, en: pinyin };
  return { primaryZh: primaryZh || zh, amapName, amapEnFull, en: zh.trim() };
}

function resolveEnglishName(amap: AmapStation | undefined, zh: string): string {
  return extractStationNames(amap, zh).en;
}

function stationIdFor(en: string | undefined, zh: string): string {
  const label = (en ?? '').trim();
  if (label && /[A-Za-z]/.test(label)) {
    const slug = label
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[''`']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return slug;
    return readableSlug(label);
  }
  return readableSlug(zh);
}

function lineIdOf(cfg: ZzLineConfig): string {
  return `${NETWORK_ID}-line-${cfg.slug}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

function asciiSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || readableSlug(s)
  );
}

/** Official feed uses `——` / `--` / `—` for non-stopping or terminal rows. */
function cleanTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().replace(/：/g, ':').replace(/\s+/g, '');
  if (!t) return undefined;
  if (/^[-–—－]+$/.test(t)) return undefined;
  // Some cells carry `0:00` placeholders for unpublished short-turns.
  if (t === '0:00' || t === '00:00') return undefined;
  // Accept `H:MM` / `HH:MM` / `HH:MM:SS`.
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 25 || mm > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function amapLineByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln) continue;
    if (!byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}

function amapStationByFold(amap: AmapSubwayDoc): Map<string, AmapStation> {
  const byFold = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

/** Official API station order is authoritative; HTML fills gaps (e.g. 14号线). */
function parseStationPageSequences(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // Split on line blocks so a line with no station list (3号线 hotline blurb)
  // cannot swallow the next line's <ul>.
  const blockRe =
    /class="Line_sites_div\s+line-(\d+)"([\s\S]*?)(?=class="Line_sites_div\s+line-|Line_sites_bigBox|<footer)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const lineClass = m[1];
    const body = m[2];
    const ul = body.match(/<ul[^>]*class="Line_sites_ul[^"]*"[\s\S]*?<\/ul>/);
    if (!ul) continue;
    const names = [...ul[0].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    if (names.length >= 2) out[lineClass] = names;
  }
  return out;
}

/** Map station-page CSS class (`line-09`) onto LINE_CONFIGS index/key. */
function htmlLineKeyToConfigKey(htmlKey: string): string | undefined {
  // HTML classes: line-1..line-17 matching official numeric-ish ids, where
  // 城郊线 is line-9 and 郑许线 is line-17.
  const n = Number(htmlKey);
  if (!Number.isFinite(n)) return undefined;
  return String(n);
}

interface HoursDirection {
  /** Destination label from the column header, e.g. `河南工业大学站`. */
  destLabel: string;
  first: (string | undefined)[];
  /** Extra short-turn last-train columns (label → times), index-aligned with rows. */
  lastExtra: { label: string; times: (string | undefined)[] }[];
  last: (string | undefined)[];
}

interface HoursTable {
  lineKey: string;
  stations: string[];
  directions: HoursDirection[];
}

/**
 * Parse `/lines/query/operating_hours` SSR HTML.
 *
 * Each table is one line. A standard linear line has
 * `站名 | 首班(往A) | 末班(往A) | 首班(往B) | 末班(往B)`.
 * Line 1 / Line 5 insert extra short-turn last-train columns.
 */
export function parseOperatingHours(html: string): HoursTable[] {
  const tabs = [...html.matchAll(/<li class="color\d+"><img[^>]*>\s*<p>([^<]+)<\/p><\/li>/g)].map(
    (m) => m[1].trim()
  );
  const tables = [...html.matchAll(/<table border="0"[^>]*class="table_lx">([\s\S]*?)<\/table>/g)];
  const out: HoursTable[] = [];

  for (let ti = 0; ti < tables.length; ti++) {
    const tableHtml = tables[ti][1];
    const ths = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    // Header row: 车站名称 | 往A（colspan） | 往B（colspan）
    const destLabels: string[] = [];
    for (const th of ths) {
      const m = /^往(.+)$/.exec(th.replace(/^车站名称$/, '').trim());
      if (m) destLabels.push(m[1].trim());
    }
    if (destLabels.length < 1) continue;

    const rows = [...tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    // First row after header is the sub-header describing columns.
    let subHeader = '';
    const dataRows: string[][] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const cells = [...rows[ri].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        c[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      );
      if (cells.length === 0) continue;
      if (/^站名$/.test(cells[0])) {
        subHeader = cells.join(' | ');
        continue;
      }
      // Station cell may be `1 河南工业大学站` after tag strip.
      dataRows.push(cells);
    }

    // Split sub-header columns into per-direction groups after the name column.
    const subCols = subHeader ? subHeader.split('|').map((s) => s.trim()) : [];
    // Typical: 站名, then for each direction: first, last, [extra last...]
    const dirCount = destLabels.length;
    const extraAfterName = subCols.slice(1);
    const colsPerDir = dirCount > 0 ? Math.floor(extraAfterName.length / dirCount) : 0;

    const directions: HoursDirection[] = [];
    for (let d = 0; d < dirCount; d++) {
      const slice = extraAfterName.slice(d * colsPerDir, (d + 1) * colsPerDir);
      // slice[0] = first, slice[1] = primary last, slice[2..] = short-turn lasts
      const lastExtra: { label: string; times: (string | undefined)[] }[] = [];
      for (let k = 2; k < slice.length; k++) {
        const lab =
          slice[k]
            .replace(/-?末班$/, '')
            .replace(/^往/, '')
            .trim() || `short-${k}`;
        lastExtra.push({ label: lab, times: [] });
      }
      directions.push({
        destLabel: destLabels[d],
        first: [],
        last: [],
        lastExtra
      });
    }

    const stations: string[] = [];
    for (const cells of dataRows) {
      const rawName = cells[0] ?? '';
      const name = `${rawName
        .replace(/^\d+\s*/, '')
        .replace(/站$/, '')
        .trim()}站`;
      if (!name || name === '站') continue;
      stations.push(name);

      let col = 1;
      for (let d = 0; d < directions.length; d++) {
        const dir = directions[d];
        dir.first.push(cleanTime(cells[col++]));
        dir.last.push(cleanTime(cells[col++]));
        for (const extra of dir.lastExtra) {
          extra.times.push(cleanTime(cells[col++]));
        }
      }
    }

    const lineName = tabs[ti] ?? '';
    const cfg = LINE_CONFIGS.find((c) => c.name === lineName);
    out.push({
      lineKey: cfg?.key ?? String(ti + 1),
      stations,
      directions
    });
  }
  return out;
}

export function normalizeZhengzhou(input: ZhengzhouSources): ZhengzhouCanonical {
  const amapByName = amapLineByName(input.amap);
  const amapStationByName = amapStationByFold(input.amap);
  const hoursTables = parseOperatingHours(input.operatingHoursHtml);
  const htmlSeqs = parseStationPageSequences(input.stationPageHtml);

  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  // ---- Lines ----------------------------------------------------------------
  const lines: LineEncoded[] = [];
  const lineById = new Map<string, LineEncoded>();
  const cfgByShort = new Map<string, ZzLineConfig>();
  const cfgByKey = new Map<string, ZzLineConfig>();

  for (const cfg of LINE_CONFIGS) {
    cfgByShort.set(cfg.short, cfg);
    cfgByKey.set(cfg.key, cfg);
    const officialName = input.lines[cfg.key] ?? cfg.name;
    const amap = amapByName.get(officialName) ?? amapByName.get(cfg.name);
    const enFromAmap = String(amap?.el ?? '').trim();
    const nameEn = enFromAmap || deriveLineEnglishName(officialName) || `Line ${cfg.short}`;
    const short = resolveLineShortName(officialName, cfg.short);
    const id = lineIdOf(cfg);
    const line: LineEncoded = {
      id,
      name: officialName,
      names: { zh: officialName, en: nameEn },
      aliases: officialName === cfg.name ? [] : [cfg.name],
      color: hexToCss(amap?.cl),
      short_name: short,
      mode: cfg.mode,
      status: 'operating',
      loop: Boolean(cfg.loop),
      source_ids: [
        { source: ZZ_SOURCE, id: cfg.key },
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((lid) => ({ source: AMAP_SOURCE, id: lid }))
          : [])
      ],
      extras: {
        names_source: enFromAmap ? 'source' : 'derived',
        amap_color: amap?.cl,
        official_key: cfg.key,
        short_label: cfg.short
      }
    };
    lines.push(line);
    lineById.set(id, line);
  }

  // ---- Physical stations ----------------------------------------------------
  type Phys = {
    id: string;
    zh: string;
    en: string;
    zids: Set<string>;
    lineKeys: Set<string>;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
    coName?: string;
    amapName?: string;
    amapEnFull?: string;
  };
  const physByFold = new Map<string, Phys>();
  const physByZid = new Map<string, Phys>();

  const ensurePhys = (zhRaw: string, zid?: string): Phys | undefined => {
    const zh = zhRaw.trim();
    if (!zh) return undefined;
    const key = foldStationName(zh);
    let phys = physByFold.get(key) ?? (zid ? physByZid.get(zid) : undefined);
    if (!phys) {
      const amap = amapStationByName.get(key);
      const names = extractStationNames(amap, zh);
      const en = names.en;
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, names.primaryZh || zh)}`,
        zh,
        en,
        zids: new Set(),
        lineKeys: new Set(),
        location: loc,
        schematic: pix,
        pinyin: String(amap?.sp ?? '').trim() || undefined,
        poiid: amap?.poiid || undefined,
        coName: names.coName,
        amapName: names.amapName,
        amapEnFull: names.amapEnFull
      };
      physByFold.set(key, phys);
      if (loc) officialLocations.set(phys.id, { ...loc, crs: 'gcj02' });
      officialLocations.set(key, { ...(loc ?? { lon: 0, lat: 0 }), crs: 'gcj02' });
      if (loc) officialLocations.set(zh, { ...loc, crs: 'gcj02' });
    }
    if (zid) {
      phys.zids.add(zid);
      if (!physByZid.has(zid)) physByZid.set(zid, phys);
    }
    // Prefer the canonical official name with 站 suffix.
    if (zh.endsWith('站') && !phys.zh.endsWith('站')) phys.zh = zh;
    physByFold.set(foldStationName(phys.zh), phys);
    return phys;
  };

  // Drop empty coords from the name-keyed map (only station-id keys are trusted).
  for (const [k, v] of officialLocations) {
    if (!Number.isFinite(v.lon) || !Number.isFinite(v.lat) || (v.lon === 0 && v.lat === 0)) {
      officialLocations.delete(k);
    }
  }

  // ---- Stops / patterns / segments / timetables -----------------------------
  type StopBuild = {
    id: string;
    station_id: string;
    line_id: string;
    sequence: number;
    is_terminal: boolean;
    source_id?: string;
    schematic?: { x: number; y: number; crs: 'schematic' };
    extras: Record<string, unknown>;
  };
  const stopById = new Map<string, StopBuild>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeySet = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();

  const ensureStop = (phys: Phys, cfg: ZzLineConfig, seq: number, zid?: string): StopBuild => {
    const lineId = lineIdOf(cfg);
    const id = stopIdOf(phys.id, cfg.short);
    const existing = stopById.get(id);
    if (existing) {
      if (zid && !existing.source_id) existing.source_id = zid;
      if (seq < existing.sequence) existing.sequence = seq;
      return existing;
    }
    const stop: StopBuild = {
      id,
      station_id: phys.id,
      line_id: lineId,
      sequence: seq,
      is_terminal: false,
      source_id: zid,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      extras: {
        line_short_name: cfg.short
      }
    };
    stopById.set(id, stop);
    return stop;
  };

  const addSegment = (
    lineId: string,
    fromStop: string,
    toStop: string,
    fromStation: string,
    toStation: string
  ) => {
    const key = [lineId, fromStop, toStop].sort().join('|');
    if (segmentKeySet.has(key)) return;
    segmentKeySet.add(key);
    segments.push({
      id: `${NETWORK_ID}-seg-${fromStop}-${toStop}`,
      line_id: lineId,
      from_stop_id: fromStop,
      to_stop_id: toStop,
      from_station_id: fromStation,
      to_station_id: toStation,
      direction: 'both',
      source_id: ZZ_SOURCE
    });
  };

  const hoursByKey = new Map(hoursTables.map((t) => [t.lineKey, t]));

  for (const cfg of LINE_CONFIGS) {
    const lineId = lineIdOf(cfg);
    const officialMap = input.stations[cfg.key] ?? {};
    // Prefer official API order (object insertion order = sequence).
    let pairs: { zid: string; name: string }[] = Object.entries(officialMap).map(([zid, name]) => ({
      zid,
      name
    }));

    // Fill / repair from HTML sequence when API is short (e.g. 14号线 须水站).
    // Only trust HTML as a superset when most names already match — a misparsed
    // block must not replace the official API sequence wholesale.
    const htmlClass = Object.keys(htmlSeqs).find((k) => htmlLineKeyToConfigKey(k) === cfg.key);
    const htmlNames = htmlClass ? htmlSeqs[htmlClass] : undefined;
    if (htmlNames && htmlNames.length > pairs.length) {
      const known = new Set(pairs.map((p) => foldStationName(p.name)));
      const extras = htmlNames.filter((n) => !known.has(foldStationName(n)));
      const matched = htmlNames.length - extras.length;
      if (extras.length > 0 && matched >= Math.floor(pairs.length * 0.8)) {
        console.log(`  ${cfg.name}: HTML adds ${extras.length} stations missing from API`);
        const byFold = new Map(pairs.map((p) => [foldStationName(p.name), p]));
        const rebuilt: { zid: string; name: string }[] = [];
        for (const n of htmlNames) {
          const hit = byFold.get(foldStationName(n));
          if (hit) rebuilt.push(hit);
          else rebuilt.push({ zid: '', name: n });
        }
        pairs = rebuilt;
      }
    }

    if (pairs.length < 2) {
      console.log(`  ${cfg.name}: only ${pairs.length} stations, skip`);
      continue;
    }

    const hours = hoursByKey.get(cfg.key);
    const stopIds: string[] = [];
    const stationIds: string[] = [];
    const physList: Phys[] = [];

    for (let i = 0; i < pairs.length; i++) {
      const { zid, name } = pairs[i];
      const phys = ensurePhys(name, zid || undefined);
      if (!phys) continue;
      phys.lineKeys.add(cfg.key);
      const stop = ensureStop(phys, cfg, i, zid || undefined);
      stopIds.push(stop.id);
      stationIds.push(phys.id);
      physList.push(phys);
    }

    stopById.get(stopIds[0])!.is_terminal = true;
    stopById.get(stopIds[stopIds.length - 1])!.is_terminal = true;
    if (cfg.loop && stopIds.length > 2) {
      // Closed ring: last stop connects back to the first.
      stopById.get(stopIds[0])!.is_terminal = true;
      stopById.get(stopIds[stopIds.length - 1])!.is_terminal = true;
    }

    // Pattern: one primary alignment per line (linear or loop).
    const patternId = `${lineId}-pattern-${asciiSlug(stopIds[0])}-to-${asciiSlug(
      stopIds[stopIds.length - 1]
    )}`;
    const pattern: PatternEncoded = {
      id: patternId,
      line_id: lineId,
      name: cfg.name,
      names: {
        zh: cfg.name,
        en: lineById.get(lineId)?.names.en ?? `Line ${cfg.short}`
      },
      stop_ids: stopIds,
      origin_stop_id: stopIds[0],
      terminal_stop_id: stopIds[stopIds.length - 1],
      is_primary: true,
      source_ids: [{ source: ZZ_SOURCE, id: cfg.key }],
      extras: {
        line_short_name: cfg.short,
        loop: Boolean(cfg.loop),
        origin_name: physList[0]?.zh,
        terminal_name: physList[physList.length - 1]?.zh
      }
    };
    patterns.push(pattern);

    for (let i = 0; i < stopIds.length - 1; i++) {
      addSegment(lineId, stopIds[i], stopIds[i + 1], stationIds[i], stationIds[i + 1]);
    }
    if (cfg.loop && stopIds.length > 2) {
      addSegment(
        lineId,
        stopIds[stopIds.length - 1],
        stopIds[0],
        stationIds[stationIds.length - 1],
        stationIds[0]
      );
    }

    // Timetables from operating_hours HTML.
    if (!hours || hours.stations.length === 0) {
      console.log(`  ${cfg.name}: no operating-hours table`);
      continue;
    }

    // Index HTML station rows by folded name.
    const hoursIdxByFold = new Map<string, number>();
    for (let i = 0; i < hours.stations.length; i++) {
      hoursIdxByFold.set(foldStationName(hours.stations[i]), i);
    }

    for (const dir of hours.directions) {
      const destLabel = dir.destLabel.replace(/站$/, '');
      // Resolve destination stop: match hours dest against this line's stations.
      // Labels may be `贾河/刘庄` (through-run) or `（内环）月季公园-黄河路-…`.
      let destStopId: string | undefined;
      let destStationId: string | undefined;
      const destCandidates = destLabel
        .split(/[/·、]/)
        .map((s) =>
          s
            .replace(/[（(].*?[）)]/g, '')
            .replace(/^往/, '')
            .replace(/站$/, '')
            .trim()
        )
        .filter((s) => s.length >= 2);
      for (const cand of destCandidates) {
        for (let i = 0; i < physList.length; i++) {
          const n = foldStationName(physList[i].zh);
          if (n === cand || n.includes(cand) || cand.includes(n)) {
            destStopId = stopIds[i];
            destStationId = stationIds[i];
            break;
          }
        }
        if (destStopId) break;
      }
      // Through-run dest (e.g. 城郊 → 贾河/刘庄 on 2号线) is not on this line.
      // Bind to the terminus in that direction so the record stays legal.
      if (!destStopId && !cfg.loop && stopIds.length > 0) {
        const firstZh = foldStationName(physList[0]?.zh ?? '');
        const lastZh = foldStationName(physList[physList.length - 1]?.zh ?? '');
        // Prefer the end whose name appears in the label; else the first stop
        // (through-run labels name the other line's terminus).
        const useFirst =
          destLabel.includes(firstZh) ||
          (!destLabel.includes(lastZh) && /[/·]|贾河|刘庄/.test(destLabel));
        const idx = useFirst ? 0 : stopIds.length - 1;
        destStopId = stopIds[idx];
        destStationId = stationIds[idx];
      }
      const directionType = cfg.loop
        ? dir.destLabel.includes('内环')
          ? ('loop_inner' as const)
          : dir.destLabel.includes('外环')
            ? ('loop_outer' as const)
            : undefined
        : undefined;

      for (let i = 0; i < physList.length; i++) {
        const hi = hoursIdxByFold.get(foldStationName(physList[i].zh));
        if (hi == null) continue;
        const first = cleanTime(dir.first[hi]);
        const last = cleanTime(dir.last[hi]);
        // Short-turn last trains → separate timetable rows toward that terminal.
        const shortTurns: { label: string; last: string | undefined }[] = dir.lastExtra
          .map((ex) => ({ label: ex.label.replace(/站$/, ''), last: cleanTime(ex.times[hi]) }))
          .filter((s) => s.last);

        // Primary direction: first+last required (schema length 1|7).
        // Short-turn last trains are last-only services — keep them on the
        // primary row as extras so we never emit first_train: [].
        const shortTurnExtras: {
          dest_stop_id?: string;
          dest_name: string;
          last_train: string;
        }[] = [];
        for (const st of shortTurns) {
          let stStop: string | undefined;
          for (let j = 0; j < physList.length; j++) {
            if (foldStationName(physList[j].zh) === st.label || physList[j].zh.includes(st.label)) {
              stStop = stopIds[j];
              break;
            }
          }
          if (st.last) {
            shortTurnExtras.push({
              dest_stop_id: stStop,
              dest_name: st.label,
              last_train: st.last
            });
          }
        }

        if (first && last) {
          // Loop dest labels both name 月季公园 (…-月季公园-…) so dest-only ids
          // collide and drop loop_inner. Stamp the direction type on the id.
          const id = `${NETWORK_ID}-${stationIds[i]}-${cfg.short}-to-${asciiSlug(
            destStationId ?? destLabel
          )}-${directionType ?? 'linear'}-primary`;
          if (!ttIds.has(id)) {
            ttIds.add(id);
            timetables.push({
              id,
              station_id: stationIds[i],
              stop_id: stopIds[i],
              line_id: lineId,
              source_id: ZZ_HOURS_SOURCE,
              destination_stop_id: cfg.loop ? undefined : destStopId,
              pattern_id: patternId,
              direction_type: directionType ?? 'linear',
              direction_label: dir.destLabel,
              first_train: [first],
              last_train: [last],
              extras: {
                service: 'primary',
                ...(shortTurnExtras.length > 0 ? { short_turns: shortTurnExtras } : {})
              }
            });
          }
        }
      }
    }
  }

  // ---- Station records ------------------------------------------------------
  // Stations with no published first/last train (e.g. 须水, times all `——`)
  // are not in passenger service for timetable purposes.
  const stationsWithTimes = new Set(timetables.map((x) => x.station_id));

  const stations: StationEncoded[] = [];
  const usedPhys = new Map<string, Phys>();
  for (const stop of stopById.values()) {
    // find phys by station_id
    for (const phys of physByFold.values()) {
      if (phys.id === stop.station_id) usedPhys.set(phys.id, phys);
    }
  }
  // physByFold may collapse; rebuild from stops' station ids via zid map.
  for (const phys of physByZid.values()) usedPhys.set(phys.id, phys);
  for (const phys of physByFold.values()) usedPhys.set(phys.id, phys);

  for (const phys of usedPhys.values()) {
    const loc = phys.location
      ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
      : undefined;
    if (loc) officialLocations.set(phys.id, loc);
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en },
      location: loc,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: stationsWithTimes.has(phys.id) ? 'operating' : 'out_of_service',
      source_ids: [...phys.zids].map((z) => ({ source: ZZ_SOURCE, id: z })),
      extras: {
        pinyin: phys.pinyin,
        poiid: phys.poiid,
        official_zids: [...phys.zids],
        co_name: phys.coName,
        amap_name: phys.amapName,
        amap_en_full: phys.amapEnFull
      }
    });
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '郑州地铁',
    names: { zh: '郑州地铁', en: 'Zhengzhou Metro' },
    city: {
      id: 'CN-4101',
      name: { zh: '郑州', en: 'Zhengzhou' },
      country: 'CN',
      population: 12600000,
      area: 7446,
      location: { type: 'Point', coordinates: [113.6254, 34.7466] }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑来自 api.zzmetro.com /api/stations；首末班来自 zzmetro.com operating_hours；线色/坐标/英文名来自 AMap Subway 4101。城郊线与 2 号线在南四环贯通至贾河/刘庄；郑许线为市域线至许昌东。'
  };

  return {
    network,
    lines,
    stations,
    stops: [...stopById.values()],
    patterns,
    segments,
    timetables,
    officialLocations
  };
}
