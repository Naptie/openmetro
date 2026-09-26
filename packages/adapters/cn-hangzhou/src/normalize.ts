import {
  applyTimetableServiceStatus,
  asciiSlug,
  cleanTime,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  parsePixel,
  parseSlCoord,
  pinyinToEnglish,
  readableSlug,
  resolveLineShortName,
  stationIdFor,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import type { AmapLine, AmapStation, HangzhouSources, HzOperationAll } from './fetch.js';

const NETWORK_ID = 'cn-hangzhou';
const HZ_SOURCE = 'hzmetro-operation-all';
const AMAP_SOURCE = 'amap-subway-3301';

export interface HangzhouCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /** AMap GCJ-02 coords keyed by station id. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}


/**
 * AMap `sp` is CamelCase pinyin (`AoTi ZhongXin`, `LvTing Lu`). Title-case it
 * so station English names / ids stay human-readable when `en` is blank.
 */

function resolveEnglishName(
  amapEn: string | undefined,
  pinyin: string | undefined,
  zh: string
): string | undefined {
  const en = (amapEn ?? '').trim();
  if (en && /^[A-Za-z]/.test(en)) return en;
  return pinyinToEnglish(pinyin);
}



/** Official/AMap names may differ by a trailing 站 or full-width parens. */



/** `"3号线（星桥-吴山前村）"` / `"6号线"` → parent short badge name `"3号线"` / `"6号线"`. */
function parentLineName(key: string): string {
  return key.replace(/[（(].*$/, '').trim() || key;
}

function branchLabel(key: string): string | undefined {
  const m = /[（(]([^)）]+)[)）]/.exec(key);
  return m?.[1]?.trim() || undefined;
}

/** `"往湘湖方向"` → `"湘湖"`. */
function destFromTitle(title: string): string | undefined {
  const t = title.replace(/方向$/, '').trim();
  const m = /^往(.+)$/.exec(t);
  if (m) return m[1].trim();
  return t || undefined;
}

function lineIdFromShort(short: string): string {
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${short}`;
}

/** Official feed uses `——` / `--` / `终点站` for non-stopping or terminal rows. */

/**
 * Station-level "not open yet" only. Official CMS blurbs often say a specific
 * exit (`C3口暂未开通`) while the station itself is in passenger service.
 */
function isNotYetOpen(description: string | undefined): boolean {
  if (!description) return false;
  return /目前暂未开通|车站暂未开通|本站暂未开通|该站暂未开通|整站暂未开通|站点暂未开通/.test(
    description
  );
}

function stopSlug(stopId: string): string {
  return stopId.replace(/^cn-hangzhou-/, '');
}

/** Official Hangzhou metro line parents — excludes bundled 绍兴/杭海 twins. */
function officialLineParents(official: HzOperationAll): Set<string> {
  const parents = new Set<string>();
  for (const meta of official.lineList ?? []) {
    const ln = String(meta.lineName ?? '').trim();
    if (!ln) continue;
    parents.add(ln);
    parents.add(parentLineName(ln));
  }
  return parents;
}

function isOfficialHangzhouLine(ln: string, parents: Set<string>): boolean {
  return parents.has(parentLineName(ln));
}

function amapLinesByName(
  amap: HangzhouSources['amapSubway'],
  officialParents: Set<string>
): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln || !isOfficialHangzhouLine(ln, officialParents)) continue;
    const parent = parentLineName(ln);
    if (!byName.has(ln)) byName.set(ln, line);
    const existing = byName.get(parent);
    // Prefer a row without branch label for parent color/EN.
    if (!existing || (existing.la && !line.la)) byName.set(parent, line);
  }
  return byName;
}

function amapStationsByName(
  amap: HangzhouSources['amapSubway'],
  officialParents: Set<string>
): Map<string, AmapStation> {
  const byFold = new Map<string, AmapStation>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (ln && !isOfficialHangzhouLine(ln, officialParents)) continue;
    for (const st of line.st ?? []) {
      const n = String(st.n ?? '').trim();
      if (!n) continue;
      const key = foldStationName(n);
      if (!byFold.has(key)) byFold.set(key, st);
    }
  }
  return byFold;
}

interface PatternBuild {
  patternId: string;
  lineId: string;
  short: string;
  sourceKey: string;
  branch?: string;
  directionTitle: string;
  destName?: string;
  stopIds: string[];
  stationIds: string[];
  codes: string[];
}

interface StopBuild {
  id: string;
  station_id: string;
  line_id: string;
  sequence: number;
  is_terminal: boolean;
  source_id?: string;
  schematic?: { x: number; y: number; crs: 'schematic' };
  extras: Record<string, unknown>;
}

export function normalizeHangzhou(input: HangzhouSources): HangzhouCanonical {
  const official: HzOperationAll = input.operationAll;
  const hzLineParents = officialLineParents(official);
  const amapByName = amapLinesByName(input.amapSubway, hzLineParents);
  const amapStationByName = amapStationsByName(input.amapSubway, hzLineParents);

  // ---- Lines ----------------------------------------------------------------
  const lineShortByName = new Map<string, string>();
  const lineIdByShort = new Map<string, string>();
  const lineRecordByShort = new Map<string, LineEncoded>();
  const amapEnByShort = new Map<string, string>();
  const officialLineCodes = new Map<string, string[]>();

  const ensureLineRecord = (short: string, lineName: string, sourceKey?: string): string => {
    const existingId = lineIdByShort.get(short);
    if (existingId && lineRecordByShort.has(short)) return existingId;
    const lineId = existingId ?? lineIdFromShort(short);
    lineIdByShort.set(short, lineId);
    if (lineRecordByShort.has(short)) return lineId;

    const amap = amapByName.get(lineName) ?? amapByName.get(short);
    const color = hexToCss(amap?.cl);
    const enFromAmap = String(amap?.el ?? '').trim();
    const nameEn = enFromAmap || deriveLineEnglishName(lineName) || `Line ${short}`;
    amapEnByShort.set(short, nameEn);
    const codes = officialLineCodes.get(short) ?? [];
    const branchLabels = new Set<string>();
    for (const key of Object.keys(official.subwaySiteDetail ?? {})) {
      if (parentLineName(key) !== lineName) continue;
      const b = branchLabel(key);
      if (b) branchLabels.add(b);
    }
    lineRecordByShort.set(short, {
      id: lineId,
      name: lineName,
      names: { zh: lineName, en: nameEn },
      aliases: [...branchLabels],
      color,
      short_name: short,
      mode: 'metro',
      status: 'operating',
      loop: false,
      source_ids: [
        ...codes.map((c) => ({ source: HZ_SOURCE, id: c })),
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : sourceKey
            ? [{ source: HZ_SOURCE, id: sourceKey }]
            : [])
      ],
      extras: {
        names_source: enFromAmap ? 'source' : 'derived',
        amap_color: amap?.cl,
        official_line_codes: codes,
        // Hangzhou `lineCode` is an API row id (3/4 = 3号线 branches), not a badge.
        // Never pass it into resolveLineShortName or it pollutes short_name matching.
        line_names: official.lineList
          .filter((l) => resolveLineShortName(String(l.lineName ?? '')) === short)
          .map((l) => ({ lineCode: l.lineCode, lineName: l.lineName, otherName: l.otherName }))
      }
    });
    return lineId;
  };

  for (const meta of official.lineList ?? []) {
    const lineName = String(meta.lineName ?? '').trim();
    if (!lineName) continue;
    // lineCode is a source-row id (3号线 has codes 3 and 4 for branches), not a badge.
    const short = resolveLineShortName(lineName);
    lineShortByName.set(lineName, short);
    const codes = officialLineCodes.get(short) ?? [];
    if (meta.lineCode && !codes.includes(meta.lineCode)) codes.push(meta.lineCode);
    officialLineCodes.set(short, codes);
    ensureLineRecord(short, lineName);
  }

  // ---- Stations -------------------------------------------------------------
  type Phys = {
    id: string;
    zh: string;
    en: string;
    code?: string;
    lineNames: Set<string>;
    description?: string;
    baiduName?: string;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
  };
  const physByFold = new Map<string, Phys>();
  const physByCode = new Map<string, Phys>();

  const ensurePhys = (zhRaw: string, code?: string): Phys | undefined => {
    const zh = zhRaw.trim();
    if (!zh) return undefined;
    const key = foldStationName(zh);
    let phys = physByFold.get(key) ?? (code ? physByCode.get(code) : undefined);
    if (!phys) {
      const amap = amapStationByName.get(key);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const en = resolveEnglishName(String(amap?.en ?? ''), pinyin, zh) ?? '';
      const loc = parseSlCoord(amap?.sl);
      const pix = parsePixel(amap?.p);
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(en, zh)}`,
        zh,
        en,
        code,
        lineNames: new Set(),
        location: loc,
        schematic: pix,
        pinyin,
        poiid: amap?.poiid || undefined
      };
      physByFold.set(key, phys);
    }
    if (code) {
      if (!phys.code) phys.code = code;
      physByCode.set(code, phys);
    }
    physByFold.set(foldStationName(phys.zh), phys);
    return phys;
  };

  for (const st of official.stationlist ?? []) {
    const phys = ensurePhys(st.stationName, st.stationCode);
    if (!phys) continue;
    for (const ln of st.lineList ?? []) phys.lineNames.add(String(ln));
    if (st.description) phys.description = st.description;
    if (st.baiduStationName) phys.baiduName = st.baiduStationName;
    if (st.stationCode && !phys.code) phys.code = st.stationCode;
  }

  // ---- Stops / patterns / timetables ---------------------------------------
  const stopById = new Map<string, StopBuild>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeySet = new Set<string>();
  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  const ensureStop = (
    phys: Phys,
    lineId: string,
    short: string,
    seq: number,
    code?: string
  ): StopBuild => {
    const id = stopIdOf(phys.id, short);
    const existing = stopById.get(id);
    if (existing) {
      // Sequence is recomputed per line after patterns are known; do not min-merge
      // across branches (that collapsed 双浦/枸桔弄 both onto seq 0).
      if (code && !existing.source_id) existing.source_id = code;
      return existing;
    }
    const stop: StopBuild = {
      id,
      station_id: phys.id,
      line_id: lineId,
      sequence: seq,
      is_terminal: false,
      source_id: code || phys.code,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      extras: {
        line_short_name: short,
        station_code: code || phys.code
      }
    };
    stopById.set(id, stop);
    return stop;
  };

  /**
   * Branch patterns are published as full through-running alignments
   * (双浦→枸桔弄 includes the shared trunk). Junction = the trunk station that
   * has a branch-only neighbour on this pattern — not "last station shared
   * with the trunk", which pins the far terminus and orphans the spur.
   */
  const findJunctionStopId = (
    patternStopIds: readonly string[],
    trunkStopIds: ReadonlySet<string>
  ): string | undefined => {
    for (let i = 0; i < patternStopIds.length; i++) {
      const id = patternStopIds[i]!;
      if (!trunkStopIds.has(id)) continue;
      const prev = i > 0 ? patternStopIds[i - 1] : undefined;
      const next = i + 1 < patternStopIds.length ? patternStopIds[i + 1] : undefined;
      if ((prev && !trunkStopIds.has(prev)) || (next && !trunkStopIds.has(next))) {
        return id;
      }
    }
    return undefined;
  };

  const detail = official.subwaySiteDetail ?? {};
  const patternBuilds: PatternBuild[] = [];

  for (const [sourceKey, directions] of Object.entries(detail)) {
    const lineName = parentLineName(sourceKey);
    const short = lineShortByName.get(lineName) ?? resolveLineShortName(lineName);
    lineShortByName.set(lineName, short);
    const lineId = ensureLineRecord(short, lineName, sourceKey);
    const branch = branchLabel(sourceKey);

    type DirSeq = {
      title: string;
      dest?: string;
      physList: Phys[];
      codes: string[];
      stopIds: string[];
      stationIds: string[];
    };
    const dirSeqs: DirSeq[] = [];

    for (const dir of directions ?? []) {
      const physList: Phys[] = [];
      const codes: string[] = [];
      const rawStations = dir.allStation ?? [];
      for (let i = 0; i < rawStations.length; i++) {
        const raw = rawStations[i];
        const zh = String(raw.sitName ?? '').trim();
        if (!zh) continue;
        const phys = ensurePhys(zh, raw.stationCode);
        if (!phys) continue;
        physList.push(phys);
        codes.push(raw.stationCode || phys.code || '');
        phys.lineNames.add(lineName);
        ensureStop(phys, lineId, short, i, raw.stationCode);
      }
      if (physList.length < 2) continue;
      const stopIds = physList.map((p) => stopIdOf(p.id, short));
      stopById.get(stopIds[0])!.is_terminal = true;
      stopById.get(stopIds[stopIds.length - 1])!.is_terminal = true;
      dirSeqs.push({
        title: dir.title,
        dest: destFromTitle(dir.title),
        physList,
        codes,
        stopIds,
        stationIds: physList.map((p) => p.id)
      });
    }

    // Keep every official direction as its own pattern (including reverses).
    // Only collapse exact duplicate alignments. Pure reverses are tagged so the
    // map UI does not paint them as「支线交路」.
    const seenSig = new Set<string>();
    const patternIdBySig = new Map<string, string>();
    let primaryTaken = false;

    for (const seq of dirSeqs) {
      const sig = seq.codes.map((c) => c || '?').join('|');
      const revSig = [...seq.codes]
        .reverse()
        .map((c) => c || '?')
        .join('|');
      if (seenSig.has(sig)) continue;
      const reverseOfId = patternIdBySig.get(revSig);
      seenSig.add(sig);

      const origin = seq.physList[0];
      const terminal = seq.physList[seq.physList.length - 1];
      const isPrimary = !branch && !primaryTaken && !reverseOfId;
      if (isPrimary) primaryTaken = true;

      const patternId = `${lineId}-pattern-${stopSlug(seq.stopIds[0])}-to-${stopSlug(
        seq.stopIds[seq.stopIds.length - 1]
      )}`;
      patternIdBySig.set(sig, patternId);
      patterns.push({
        id: patternId,
        line_id: lineId,
        name: branch ? `${lineName}（${branch}）` : lineName,
        names: {
          zh: branch ? `${lineName}（${branch}）` : lineName,
          en: branch
            ? `${amapEnByShort.get(short) || `Line ${short}`} (${branch})`
            : amapEnByShort.get(short) || `Line ${short}`
        },
        stop_ids: seq.stopIds,
        origin_stop_id: seq.stopIds[0],
        terminal_stop_id: seq.stopIds[seq.stopIds.length - 1],
        is_primary: isPrimary,
        source_ids: [{ source: HZ_SOURCE, id: sourceKey }],
        extras: {
          direction_title: seq.title,
          dest_name: seq.dest,
          origin_name: origin.zh,
          terminal_name: terminal.zh,
          branch,
          source_key: sourceKey,
          line_short_name: short,
          pattern_role: reverseOfId ? 'reverse' : branch ? 'branch' : 'direction',
          reverse_of: reverseOfId
        }
      });
      patternBuilds.push({
        patternId,
        lineId,
        short,
        sourceKey,
        branch,
        directionTitle: seq.title,
        destName: seq.dest,
        stopIds: seq.stopIds,
        stationIds: seq.stationIds,
        codes: seq.codes
      });

      for (let i = 0; i < seq.stopIds.length - 1; i++) {
        const aStop = seq.stopIds[i];
        const bStop = seq.stopIds[i + 1];
        const key = [lineId, aStop, bStop].sort().join('|');
        if (segmentKeySet.has(key)) continue;
        segmentKeySet.add(key);
        segments.push({
          id: `${NETWORK_ID}-seg-${aStop}-${bStop}`,
          line_id: lineId,
          from_stop_id: aStop,
          to_stop_id: bStop,
          from_station_id: seq.stationIds[i],
          to_station_id: seq.stationIds[i + 1],
          direction: 'both',
          source_id: HZ_SOURCE
        });
      }
    }

    // Exactly one primary per line (longest alignment); stamp junctions on branches.
    const linePatternIdx = patterns
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.line_id === lineId);
    if (linePatternIdx.length > 0) {
      const winner = [...linePatternIdx].sort(
        (a, b) => b.p.stop_ids.length - a.p.stop_ids.length
      )[0];
      const trunk = new Set(winner.p.stop_ids);
      for (const { p, i } of linePatternIdx) {
        const isPrimary = p.id === winner.p.id;
        const junction = isPrimary ? undefined : findJunctionStopId(p.stop_ids, trunk);
        patterns[i] = { ...p, is_primary: isPrimary, junction_stop_id: junction };
      }
    }

    // Timetables: one record per official direction × station, bound to the
    // pattern whose stop order matches that direction (not "first pattern that
    // contains the stop", which collapsed every label onto the primary dest).
    for (const seq of dirSeqs) {
      const destStopIdRaw = seq.stopIds[seq.stopIds.length - 1];
      const destStationId = seq.stationIds[seq.stationIds.length - 1];
      const originStopId = seq.stopIds[0];
      const dir = (detail[sourceKey] ?? []).find((d) => d.title === seq.title);
      const exact = patternBuilds.find(
        (p) => p.lineId === lineId && p.stopIds.join('|') === seq.stopIds.join('|')
      );
      const fallback = patternBuilds.find((p) => p.lineId === lineId && p.sourceKey === sourceKey);
      const patternId = exact?.patternId ?? fallback?.patternId;
      if (!patternId) continue;

      for (let i = 0; i < seq.physList.length; i++) {
        const raw = dir?.allStation?.[i];
        if (!raw) continue;
        const first = cleanTime(raw.startTime);
        const last = cleanTime(raw.endTime);
        if (!first && !last) continue;
        const phys = seq.physList[i];
        const stopId = seq.stopIds[i];
        const id = `${NETWORK_ID}-${phys.id}-${short}-to-${asciiSlug(destStationId)}-${asciiSlug(
          seq.title
        )}`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        timetables.push({
          id,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          station_code: raw.stationCode || phys.code,
          source_id: HZ_SOURCE,
          // Official direction terminal — never inherit another pattern's end.
          destination_stop_id: destStopIdRaw,
          origin_stop_id: originStopId,
          pattern_id: patternId,
          direction_type: 'linear',
          direction_label: seq.title,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          service: 'all_days',
          extras: {
            calendar: 'weekday',
            source_title: official.title,
            source_key: sourceKey,
            dest_name: seq.dest,
            line_short_name: short
          }
        });
      }
    }
  }

  // Unique stop.sequence per line: primary order first, then branch-only stops.
  {
    const assigned = new Set<string>();
    const ordered = [...patterns].sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return b.stop_ids.length - a.stop_ids.length;
    });
    const lineNext = new Map<string, number>();
    for (const p of ordered) {
      let next = lineNext.get(p.line_id) ?? 0;
      for (const stopId of p.stop_ids) {
        const stop = stopById.get(stopId);
        if (!stop || assigned.has(stop.id)) continue;
        stop.sequence = next++;
        assigned.add(stop.id);
      }
      lineNext.set(p.line_id, next);
    }
  }

  // ---- Station + stop records ----------------------------------------------
  const usedStopStationIds = new Set([...stopById.values()].map((s) => s.station_id));
  const stationsById = new Map<string, Phys>();
  for (const phys of physByFold.values()) {
    if (!usedStopStationIds.has(phys.id)) continue;
    if (!stationsById.has(phys.id)) stationsById.set(phys.id, phys);
  }

  const filteredTimetables = timetables.filter((t) => hasValidTimes(t));
  const ttStationIds = new Set(filteredTimetables.map((t) => t.station_id));

  let stations: StationEncoded[] = [];
  for (const phys of stationsById.values()) {
    const location =
      phys.location != null
        ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
        : undefined;
    if (location) officialLocations.set(phys.id, location);
    // Station-level CMS text + zero published times. Exit-only notices do not count.
    const notYetOpen = isNotYetOpen(phys.description) && !ttStationIds.has(phys.id);
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en || '' },
      location,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: notYetOpen ? 'under_construction' : 'operating',
      source_ids: [
        ...(phys.code ? [{ source: HZ_SOURCE, id: phys.code }] : []),
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : []),
        { source: HZ_SOURCE, id: phys.zh }
      ],
      extras: {
        official_codes: phys.code ? [phys.code] : [],
        pinyin: phys.pinyin,
        baidu_station_name: phys.baiduName,
        description: phys.description,
        lines: [...phys.lineNames],
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived',
        service_status_source: notYetOpen ? 'official_description' : undefined
      }
    });
  }

  // Operating stations on a timetable-publishing line must own times of their own.
  // Keeps derived stops (e.g. 汤家村) as out_of_service when the feed shows `——`.
  stations = applyTimetableServiceStatus(
    stations,
    [...stopById.values()].map((s) => ({
      id: s.id,
      station_id: s.station_id,
      line_id: s.line_id,
      sequence: s.sequence,
      is_terminal: s.is_terminal,
      source_id: s.source_id,
      schematic: s.schematic,
      extras: s.extras
    })),
    filteredTimetables
  );

  const stops: StopEncoded[] = [...stopById.values()]
    .map((s) => ({
      id: s.id,
      station_id: s.station_id,
      line_id: s.line_id,
      sequence: s.sequence,
      is_terminal: s.is_terminal,
      source_id: s.source_id,
      schematic: s.schematic,
      extras: s.extras
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '杭州地铁',
    names: { zh: '杭州地铁', en: 'Hangzhou Metro' },
    city: {
      id: 'CN-3301',
      name: { zh: '杭州', en: 'Hangzhou' },
      country: 'CN',
      population: 12376000,
      area: 16850,
      location: { type: 'Point', coordinates: [120.1551, 30.2741] }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与首末班来自杭州地铁官网 operation/all（工作日时刻表口径）；线色/坐标/英文名来自官网线网图所使用的 AMap Subway 数据。'
  };

  return {
    network,
    lines: [...lineRecordByShort.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops,
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: segments.sort((a, b) => a.id.localeCompare(b.id)),
    transfers: [],
    timetables: filteredTimetables,
    officialLocations
  };
}
