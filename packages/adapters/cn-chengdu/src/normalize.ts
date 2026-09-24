import {
  applyTimetableServiceStatus,
  canonicalizePatterns,
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import type {
  AmapLine,
  AmapStation,
  AmapSubwayDoc,
  CdLine,
  CdStation,
  CdSubLine,
  ChengduSources
} from './fetch.js';

const NETWORK_ID = 'cn-chengdu';
const CD_SOURCE = 'chengdurail-station-time';
const AMAP_SOURCE = 'amap-subway-5101';

/** Line 7 is Chengdu's only circular metro line (seam at 火车北站 / 北站西二路). */
const LOOP_LINE_NOS = new Set(['07']);

/** Operational annotations appended to official station display names. */
const ANNOTATION_RE = /[（(](?:出闸换乘|仅换乘|暂缓开通)[)）]/g;

/** CJK short_name → stable ASCII slug for line/stop ids. */
const SHORT_SLUG: Record<string, string> = {
  蓉2: 'rong2'
};

export interface ChengduCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

function asciiSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || readableSlug(s)
  );
}

/**
 * Official/AMap names may differ by trailing 站, middle dots (`中医大·省医院`),
 * full-width parens, or operational annotations.
 */
export function foldStationName(zh: string): string {
  return zh
    .trim()
    .replace(ANNOTATION_RE, '')
    .replace(/[·•・‧・]/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/站$/, '')
    .trim();
}

function stripAnnotations(zh: string): string {
  return zh.trim().replace(ANNOTATION_RE, '').trim();
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

function hexToCss(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const m = hex.replace(/^#/, '').trim();
  if (m.length !== 6 && m.length !== 3) return undefined;
  return `#${m.toLowerCase()}`;
}

function cleanTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().replace('：', ':');
  if (!t || /^[-–—－]+$/.test(t)) return undefined;
  if (!/^\d{1,2}:\d{2}$/.test(t)) return undefined;
  return t;
}

function stationIdFor(en: string | undefined, zh: string): string {
  const label = (en ?? '').trim();
  if (label && /[A-Za-z]/.test(label)) {
    const slug = label
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[''`']/g, '')
      .replace(/ʳ/g, 'r')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return slug;
    return readableSlug(label);
  }
  return readableSlug(zh);
}

function shortSlug(short: string): string {
  return SHORT_SLUG[short] ?? (asciiSlug(short) || readableSlug(short));
}

function lineIdFromShort(short: string): string {
  return `${NETWORK_ID}-line-${shortSlug(short)}`;
}

function stopIdOf(stationId: string, short: string): string {
  return `${stationId}-${shortSlug(short)}`;
}

function stopSlug(stopId: string): string {
  return stopId.replace(/^cn-chengdu-/, '');
}

/**
 * Official line rows for one physical line. 蓉2 is published as 主线/支线
 * (`101`/`102`) but is a single tram with a branch at 新业路.
 */
interface LineGroup {
  short: string;
  displayName: string;
  nameEn: string;
  color?: string;
  lineNos: string[];
  mode: LineEncoded['mode'];
  loop: boolean;
  rows: CdLine[];
}

function modeForLine(short: string, displayName: string): LineEncoded['mode'] {
  if (short === '蓉2' || displayName.includes('有轨电车') || displayName.includes('蓉2'))
    return 'tram';
  if (short === 'S3' || displayName.includes('资阳')) return 'suburban_rail';
  return 'metro';
}

function groupLines(data: CdLine[]): LineGroup[] {
  const groups = new Map<string, LineGroup>();
  for (const row of data) {
    const lineNo = String(row.lineNo ?? '').trim();
    const rawName = String(row.lineNameZh ?? row.lineName ?? '').trim();
    if (!rawName) continue;

    let short: string;
    let displayName: string;
    let nameEn: string;
    if (lineNo === '101' || lineNo === '102' || rawName.includes('蓉2')) {
      short = '蓉2';
      displayName = '蓉2号线';
      nameEn = 'Tram Line 2';
    } else {
      short = resolveLineShortName(rawName, lineNo === 'S3' ? 'S3' : undefined);
      // Keep the official display name (`S3（资阳）线`); short_name is `S3`.
      displayName = rawName;
      nameEn = String(row.lineNameEn ?? '').trim() || `Line ${short}`;
    }

    const key = short;
    let g = groups.get(key);
    if (!g) {
      g = {
        short,
        displayName,
        nameEn,
        color: hexToCss(row.lineColor),
        lineNos: [],
        mode: modeForLine(short, displayName),
        loop: LOOP_LINE_NOS.has(lineNo),
        rows: []
      };
      groups.set(key, g);
    }
    if (hexToCss(row.lineColor) && !g.color) g.color = hexToCss(row.lineColor);
    if (LOOP_LINE_NOS.has(lineNo)) g.loop = true;
    if (!g.lineNos.includes(lineNo)) g.lineNos.push(lineNo);
    g.rows.push(row);
  }
  return [...groups.values()];
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

export function normalizeChengdu(input: ChengduSources): ChengduCanonical {
  const groups = groupLines(input.stationTime.data ?? []);
  const amapStationByName = amapStationsByName(input.amapSubway);
  const amapLineByFold = amapLinesByName(input.amapSubway);

  type Phys = {
    id: string;
    zh: string;
    en: string;
    codes: string[];
    stationNo?: string;
    transferLines: Set<string>;
    lineNames: Set<string>;
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    pinyin?: string;
    poiid?: string;
  };
  const physByFold = new Map<string, Phys>();

  const ensurePhys = (raw: CdStation): Phys => {
    const zh = stripAnnotations(raw.stationNameZh || raw.stationName || '');
    const key = foldStationName(zh);
    let phys = physByFold.get(key);
    if (!phys) {
      const amap = amapStationByName.get(key);
      const pinyin = String(amap?.sp ?? '').trim() || undefined;
      const enFromSource = String(raw.stationNameEn ?? '').trim();
      const enFromAmap = String(amap?.multilang?.n?.en ?? amap?.en ?? '').trim();
      const en = enFromSource || enFromAmap || pinyin || zh;
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(enFromSource || enFromAmap, zh)}`,
        zh,
        en,
        codes: [],
        stationNo: raw.stationNo || undefined,
        transferLines: new Set(),
        lineNames: new Set(),
        location: parseSlCoord(amap?.sl),
        schematic: parsePixel(amap?.p),
        pinyin,
        poiid: amap?.poiid || undefined
      };
      physByFold.set(key, phys);
    }
    for (const c of raw.stationCodes ?? []) {
      const code = `${c.lineNo}:${c.stationCode}`;
      if (!phys.codes.includes(code)) phys.codes.push(code);
    }
    if (raw.stationNo && !phys.stationNo) phys.stationNo = raw.stationNo;
    for (const tl of String(raw.transferLines ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      phys.transferLines.add(tl);
    }
    return phys;
  };

  const lineShortByName = new Map<string, string>();
  const lineRecordByShort = new Map<string, LineEncoded>();
  const lineIdByShort = new Map<string, string>();

  const ensureLineRecord = (g: LineGroup): string => {
    const short = g.short;
    const existing = lineIdByShort.get(short);
    if (existing && lineRecordByShort.has(short)) return existing;
    const lineId = existing ?? lineIdFromShort(short);
    lineIdByShort.set(short, lineId);
    if (lineRecordByShort.has(short)) return lineId;

    const amap =
      amapLineByFold.get(foldStationName(g.displayName)) ?? amapLineByFold.get(g.displayName);
    const color = g.color ?? hexToCss(amap?.cl);
    const aliases = g.rows
      .map((r) => String(r.lineName ?? '').trim())
      .filter((n) => n && n !== g.displayName);

    lineRecordByShort.set(short, {
      id: lineId,
      name: g.displayName,
      names: { zh: g.displayName, en: g.nameEn },
      aliases,
      color,
      short_name: short,
      mode: g.mode,
      status: 'operating',
      loop: g.loop,
      source_ids: [
        ...g.lineNos.map((n) => ({ source: CD_SOURCE, id: n })),
        ...(amap?.li
          ? String(amap.li)
              .split('|')
              .filter(Boolean)
              .map((id) => ({ source: AMAP_SOURCE, id }))
          : [])
      ],
      extras: {
        names_source: g.nameEn ? 'source' : 'derived',
        official_line_nos: g.lineNos,
        amap_color: amap?.cl
      }
    });
    lineShortByName.set(g.displayName, short);
    return lineId;
  };

  for (const g of groups) ensureLineRecord(g);

  const stopById = new Map<string, StopBuild>();
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const segmentKeySet = new Set<string>();
  const timetableSeeds: TimetableEncoded[] = [];
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
      if (code && !existing.source_id) existing.source_id = code;
      return existing;
    }
    const stop: StopBuild = {
      id,
      station_id: phys.id,
      line_id: lineId,
      sequence: seq,
      is_terminal: false,
      source_id: code,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      extras: { line_short_name: short, station_code: code }
    };
    stopById.set(id, stop);
    return stop;
  };

  for (const g of groups) {
    const short = g.short;
    const lineId = ensureLineRecord(g);

    type DirSeq = {
      description: string;
      direction: string;
      physList: Phys[];
      stopIds: string[];
      stationIds: string[];
      codes: string[];
      raw: CdStation[];
    };
    const dirSeqs: DirSeq[] = [];

    for (const sub of g.rows.flatMap((r) => r.subLine ?? []) as CdSubLine[]) {
      const physList: Phys[] = [];
      const codes: string[] = [];
      const rawStations = sub.stationList ?? [];
      for (let i = 0; i < rawStations.length; i++) {
        const raw = rawStations[i];
        const zh = stripAnnotations(raw.stationNameZh || raw.stationName || '');
        if (!zh) continue;
        const phys = ensurePhys(raw);
        phys.lineNames.add(g.displayName);
        physList.push(phys);
        codes.push(raw.stationCode || '');
        ensureStop(phys, lineId, short, i, raw.stationCode || raw.stationNo);
      }
      if (physList.length < 2) continue;
      const stopIds = physList.map((p) => stopIdOf(p.id, short));
      stopById.get(stopIds[0])!.is_terminal = true;
      stopById.get(stopIds[stopIds.length - 1])!.is_terminal = true;
      dirSeqs.push({
        description: sub.description,
        direction: sub.direction,
        physList,
        stopIds,
        stationIds: physList.map((p) => p.id),
        codes,
        raw: rawStations
      });
    }

    // One pattern per unique alignment — pure reverses are the same alignment
    // (direction lives on timetable.destination_stop_id). Spur branches are
    // stub-ified later so only the junction appears on multiple patterns.
    // Mark the longest source alignment as primary so a through-running branch
    // cannot steal the main line's identity during canonicalize.
    const seenSig = new Set<string>();
    const uniqueSeqs = dirSeqs.filter((seq) => {
      const sig = seq.codes.map((c) => c || '?').join('|');
      const revSig = [...seq.codes]
        .reverse()
        .map((c) => c || '?')
        .join('|');
      if (seenSig.has(sig) || seenSig.has(revSig)) return false;
      seenSig.add(sig);
      return true;
    });
    const primarySeq = [...uniqueSeqs].sort((a, b) => b.stopIds.length - a.stopIds.length)[0];

    for (const seq of dirSeqs) {
      const isUniqueAlignment = uniqueSeqs.includes(seq);
      if (isUniqueAlignment) {
        const patternId = `${lineId}-pattern-${stopSlug(seq.stopIds[0])}-to-${stopSlug(
          seq.stopIds[seq.stopIds.length - 1]
        )}`;
        patterns.push({
          id: patternId,
          line_id: lineId,
          name: g.displayName,
          names: { zh: g.displayName, en: g.nameEn },
          stop_ids: seq.stopIds,
          origin_stop_id: seq.stopIds[0],
          terminal_stop_id: seq.stopIds[seq.stopIds.length - 1],
          is_primary: seq === primarySeq,
          source_ids: [{ source: CD_SOURCE, id: seq.description }],
          extras: {
            description: seq.description,
            direction: seq.direction,
            origin_name: seq.physList[0]!.zh,
            terminal_name: seq.physList[seq.physList.length - 1]!.zh,
            line_short_name: short,
            pattern_role: 'direction'
          }
        });
      }

      // Segments and first/last trains cover BOTH directions (undirected edges;
      // direction lives on the timetable destination).
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
          source_id: CD_SOURCE
        });
      }

      const destStopId = seq.stopIds[seq.stopIds.length - 1];
      const originStopId = seq.stopIds[0];
      for (let i = 0; i < seq.physList.length; i++) {
        const raw = seq.raw[i];
        if (!raw) continue;
        const first = cleanTime(raw.startTime);
        const last = cleanTime(raw.endTime);
        if (!first && !last) continue;
        const phys = seq.physList[i];
        const stopId = seq.stopIds[i];
        const id = `${NETWORK_ID}-${stopId}-to-${asciiSlug(destStopId)}-${asciiSlug(seq.description)}`;
        if (ttIds.has(id)) continue;
        ttIds.add(id);
        timetableSeeds.push({
          id,
          station_id: phys.id,
          stop_id: stopId,
          line_id: lineId,
          station_code: raw.stationCode || undefined,
          source_id: CD_SOURCE,
          destination_stop_id: destStopId,
          origin_stop_id: originStopId,
          // Resolved after canonicalizePatterns (spurs may be stubbed).
          pattern_id: '',
          direction_type: g.loop
            ? seq.direction === '01'
              ? 'loop_outer'
              : 'loop_inner'
            : 'linear',
          direction_label: seq.description,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          service: 'all_days',
          extras: {
            calendar: 'all_days',
            source_description: seq.description,
            line_short_name: short
          }
        });
      }
    }

    // Close the loop: the two published termini are physically adjacent.
    if (g.loop) {
      const primary = patterns
        .filter((p) => p.line_id === lineId)
        .sort((a, b) => b.stop_ids.length - a.stop_ids.length)[0];
      if (primary) {
        const stops = primary.stop_ids;
        const a = stops[0]!;
        const b = stops[stops.length - 1]!;
        const key = [lineId, a, b].sort().join('|');
        if (!segmentKeySet.has(key)) {
          segmentKeySet.add(key);
          const aStation = stopById.get(a)!.station_id;
          const bStation = stopById.get(b)!.station_id;
          segments.push({
            id: `${NETWORK_ID}-seg-${a}-${b}`,
            line_id: lineId,
            from_stop_id: a,
            to_stop_id: b,
            from_station_id: aStation,
            to_station_id: bStation,
            direction: 'both',
            source_id: CD_SOURCE,
            extras: { role: 'loop_closure' }
          });
        }
      }
    }
  }

  // Collapse reverse duplicates, pick primaries, stub-ify through-running
  // branches to junction spurs, drop subset short-turns.
  const canonical = canonicalizePatterns(patterns);
  patterns.length = 0;
  patterns.push(...canonical.patterns);
  if (canonical.droppedPatternIds.length > 0) {
    console.log(`  patterns: dropped ${canonical.droppedPatternIds.length} (reverse/subset)`);
  }
  if (canonical.stubbedPatternIds.length > 0) {
    console.log(
      `  patterns: stubbed ${canonical.stubbedPatternIds.length} through-running branch(es)`
    );
  }

  // Re-bind timetables to the canonical patterns. A through-running dest may sit
  // on another pattern of the line after stub-ification — keep the official row
  // and attach it to whichever pattern serves the stop.
  const patternsByLine = new Map<string, PatternEncoded[]>();
  for (const p of patterns) {
    const list = patternsByLine.get(p.line_id) ?? [];
    list.push(p);
    patternsByLine.set(p.line_id, list);
  }
  const timetables: TimetableEncoded[] = [];
  for (const seed of timetableSeeds) {
    const candidates = patternsByLine.get(seed.line_id) ?? [];
    const destId = seed.destination_stop_id;
    const fit =
      candidates.find(
        (p) => p.stop_ids.includes(seed.stop_id) && destId != null && p.stop_ids.includes(destId)
      ) ?? candidates.find((p) => p.stop_ids.includes(seed.stop_id));
    if (!fit) continue;
    timetables.push({ ...seed, pattern_id: fit.id });
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

  const usedStopStationIds = new Set([...stopById.values()].map((s) => s.station_id));
  const stationsById = new Map<string, Phys>();
  for (const phys of physByFold.values()) {
    if (!usedStopStationIds.has(phys.id)) continue;
    if (!stationsById.has(phys.id)) stationsById.set(phys.id, phys);
  }

  const filteredTimetables = timetables.filter(
    (t) => t.first_train.length > 0 || t.last_train.length > 0
  );

  let stations: StationEncoded[] = [];
  for (const phys of stationsById.values()) {
    const location =
      phys.location != null
        ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' as const }
        : undefined;
    if (location) officialLocations.set(phys.id, location);
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en || phys.zh },
      location,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' as const }
        : undefined,
      status: 'operating',
      source_ids: [
        ...(phys.stationNo ? [{ source: CD_SOURCE, id: phys.stationNo }] : []),
        ...(phys.poiid ? [{ source: AMAP_SOURCE, id: phys.poiid }] : []),
        { source: CD_SOURCE, id: phys.zh }
      ],
      extras: {
        official_codes: phys.codes,
        station_no: phys.stationNo,
        transfer_lines: [...phys.transferLines],
        lines: [...phys.lineNames],
        pinyin: phys.pinyin,
        location_source: location ? 'official' : undefined,
        location_provider: location ? 'amap_subway' : undefined,
        names_source: phys.en && phys.en !== phys.zh ? 'source' : 'derived'
      }
    });
  }

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
    name: '成都轨道交通',
    names: { zh: '成都轨道交通', en: 'Chengdu Rail Transit' },
    city: {
      id: 'CN-5101',
      name: { zh: '成都', en: 'Chengdu' },
      country: 'CN',
      population: 21403000,
      area: 14335,
      location: { type: 'Point', coordinates: [104.066, 30.572] }
    },
    country_code: 'CN',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑、交路与首末班来自成都轨道集团官网 /op/station-time；坐标/英文名补充来自官网线网图所使用的 AMap Subway 数据。7 号线为环线。蓉2 号线主/支线合并为一条有轨电车。'
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

function amapStationsByName(amap: AmapSubwayDoc): Map<string, AmapStation> {
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

function amapLinesByName(amap: AmapSubwayDoc): Map<string, AmapLine> {
  const byName = new Map<string, AmapLine>();
  for (const line of amap.l ?? []) {
    const ln = String(line.ln ?? '').trim();
    if (!ln) continue;
    if (!byName.has(ln)) byName.set(ln, line);
  }
  return byName;
}
