/**
 * AMap subway dataset helpers for cn-xuzhou (city code 3203).
 *
 * The dataset is a plain static JSON file — no key, no signing — and it
 * carries everything the operator's own site does not publish in machine-
 * readable form: GCJ-02 coordinates, **real English station names**, line
 * colours and the schematic pixel grid.
 *
 * Two traps this module handles:
 *
 * 1. **The English name lives in `multilang.n.en`, not in `en`.** The
 *    top-level `en` field is empty for every Xuzhou station (0/76), while
 *    `multilang.n.en` is populated for **all 76** — `Xuzhou Railway Station`,
 *    `The Affiliated Hospital of Xuzhou Medical University`,
 *    `Municipal Administrative Center`, … The shared core helper
 *    (`core/geocode/subway.ts`) only reads `sp` (pinyin), so an adapter that
 *    routes through it degrades to pinyin names; this module reads the real
 *    English labels.
 * 2. **AMap's per-line station order is not the operator's order.** Lines 1 and
 *    2 match the official order exactly, but lines 3 and 6 are listed from the
 *    opposite terminus. The official `dropBox` tree is authoritative for the
 *    line order, so stations are joined **by name within a line** — a name is
 *    unique inside a line, while the same name can appear on two lines
 *    (the six interchanges).
 */
import { foldStationName, parsePixel, parseSlCoord, titleCaseRoman } from '@openmetro/core';
import type { AmapLine, AmapStation, AmapSubwayDoc } from './fetch.js';

/** One station as this adapter needs it. */
export interface AmapStationInfo {
  /** Chinese name as AMap publishes it. */
  name: string;
  /** English name from `multilang.n.en` (normalised), or '' when absent. */
  english: string;
  /** CamelCase pinyin (`LuWo`). */
  pinyin?: string;
  /** AMap POI id. */
  poiid?: string;
  /** GCJ-02 coordinate. */
  location?: { lon: number; lat: number };
  /** Schematic pixel position on AMap's line map. */
  schematic?: { x: number; y: number };
}

/**
 * Normalise an AMap English label.
 *
 * AMap mixes real English (`Xuzhou Railway Station`) with an all-caps style
 * (`BAIXIANG St.`); the all-caps form is title-cased so the canonical
 * `names.en` stays readable.
 */
export function normalizeEnglishName(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (!letters) return undefined;
  if (letters === letters.toUpperCase()) return titleCaseRoman(t);
  return t;
}

/** The English name AMap publishes for a station. */
export function amapEnglishName(st: AmapStation | undefined): string {
  return normalizeEnglishName(st?.multilang?.n?.en) ?? '';
}

/** Everything this adapter needs from one AMap station record. */
export function amapStationInfo(st: AmapStation | undefined): AmapStationInfo | undefined {
  if (!st) return undefined;
  const name = String(st.n ?? '').trim();
  if (!name) return undefined;
  return {
    name,
    english: amapEnglishName(st),
    pinyin: String(st.sp ?? '').trim() || undefined,
    poiid: st.poiid ? String(st.poiid) : undefined,
    location: parseSlCoord(st.sl),
    schematic: parsePixel(st.p)
  };
}

/** AMap line objects by their Chinese name (`1号线`). */
export function amapLineByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln) continue;
    if (!byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}

/**
 * One line's AMap stations, keyed by folded Chinese name.
 *
 * A name is unique inside a line, so the index is unambiguous even though the
 * same physical station appears on two lines.
 */
export function amapStationsByName(line: AmapLine | undefined): Map<string, AmapStationInfo> {
  const out = new Map<string, AmapStationInfo>();
  for (const st of line?.st ?? []) {
    const info = amapStationInfo(st);
    if (!info) continue;
    const key = foldStationName(info.name);
    if (!out.has(key)) out.set(key, info);
  }
  return out;
}

/** The AMap line's English name (`Line 1`), when published. */
export function amapLineEnglishName(line: AmapLine | undefined): string | undefined {
  return normalizeEnglishName(line?.multilang?.ln?.en);
}

/** The AMap line's colour (`CC0000`), without a leading `#`. */
export function amapLineColor(line: AmapLine | undefined): string | undefined {
  const cl = String(line?.cl ?? '').trim();
  return /^[0-9A-Fa-f]{6}$/.test(cl) ? cl : undefined;
}
