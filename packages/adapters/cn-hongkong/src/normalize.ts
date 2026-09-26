import type { FareMatrixEncoded } from '@openmetro/core';
import {
  type LineEncoded,
  type NetworkEncoded,
  type PatternEncoded,
  placeholderCity,
  readableSlug,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import { buildFareMatrix, foldFareName } from './fares.js';
import type { MtrLineStationRow, MtrSources } from './fetch.js';

const NETWORK_ID = 'cn-hongkong';
const MTR_SOURCE = 'mtr-lines-and-stations';

/** Official MTR line branding (code → display names, colour, mode). */
const LINE_META: Record<
  string,
  { zh: string; en: string; color: string; mode: LineEncoded['mode'] }
> = {
  AEL: { zh: '機場快綫', en: 'Airport Express', color: '#00888a', mode: 'airport_express' },
  TCL: { zh: '東涌綫', en: 'Tung Chung Line', color: '#f7943e', mode: 'metro' },
  TML: { zh: '屯馬綫', en: 'Tuen Ma Line', color: '#923011', mode: 'metro' },
  TKL: { zh: '將軍澳綫', en: 'Tseung Kwan O Line', color: '#7d499d', mode: 'metro' },
  EAL: { zh: '東鐵綫', en: 'East Rail Line', color: '#5eb7e8', mode: 'metro' },
  SIL: { zh: '南港島綫', en: 'South Island Line', color: '#bac429', mode: 'metro' },
  TWL: { zh: '荃灣綫', en: 'Tsuen Wan Line', color: '#e2231a', mode: 'metro' },
  ISL: { zh: '港島綫', en: 'Island Line', color: '#0075c2', mode: 'metro' },
  KTL: { zh: '觀塘綫', en: 'Kwun Tong Line', color: '#00ab4e', mode: 'metro' },
  DRL: { zh: '迪士尼綫', en: 'Disneyland Resort Line', color: '#f550a1', mode: 'metro' }
};

export interface HongKongCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  fares: FareMatrixEncoded;
  /** AMap GCJ-02 coords keyed by station id (English-name matched). */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
}

/** MTR "HKU" vs AMap "HKU (Hong Kong University)". */
const EN_NAME_ALIASES: Record<string, string> = {
  hku: 'hkuhongkonguniversity'
};

function foldEn(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[''`']/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

interface PhysStation {
  id: string;
  zh: string;
  en: string;
  sourceIds: string[];
  lineCodes: Set<string>;
}

interface Alignment {
  lineCode: string;
  direction: string;
  stationIds: string[];
  stopIds: string[];
}

function stopIdFor(stationId: string, lineCode: string): string {
  return `${stationId}-${lineCode.toLowerCase()}`;
}

function lineIdFor(lineCode: string): string {
  return `${NETWORK_ID}-line-${lineCode.toLowerCase()}`;
}

export function normalizeHongKong(sources: MtrSources): HongKongCanonical {
  const rows = sources.lineStations;

  // Physical stations: MTR publishes separate Station IDs for AEL vs urban
  // platforms at the same complex (Hong Kong 39 vs 44). Merge by English name.
  const physByFolded = new Map<string, PhysStation>();
  const stationIdToPhys = new Map<string, string>();

  for (const row of rows) {
    const key = foldFareName(row.englishName);
    let phys = physByFolded.get(key);
    if (!phys) {
      phys = {
        id: stationIdFor(row.englishName, row.chineseName || row.englishName),
        zh: row.chineseName || row.englishName,
        en: row.englishName,
        sourceIds: [],
        lineCodes: new Set()
      };
      physByFolded.set(key, phys);
    }
    if (!phys.sourceIds.includes(row.stationId)) phys.sourceIds.push(row.stationId);
    phys.lineCodes.add(row.lineCode);
    stationIdToPhys.set(row.stationId, phys.id);
    if (!phys.zh && row.chineseName) phys.zh = row.chineseName;
  }

  // Group source rows into one alignment per (lineCode, direction).
  const byDir = new Map<string, MtrLineStationRow[]>();
  for (const row of rows) {
    const k = `${row.lineCode}|${row.direction}`;
    const list = byDir.get(k) ?? [];
    list.push(row);
    byDir.set(k, list);
  }

  const alignments: Alignment[] = [];
  for (const [key, list] of byDir) {
    const [lineCode, direction] = key.split('|');
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    const stationIds: string[] = [];
    const stopIds: string[] = [];
    for (const row of ordered) {
      const physId = stationIdToPhys.get(row.stationId);
      if (!physId) continue;
      const stopId = stopIdFor(physId, lineCode);
      if (!stationIds.includes(physId)) {
        stationIds.push(physId);
        stopIds.push(stopId);
      }
    }
    if (stationIds.length >= 2) {
      alignments.push({ lineCode, direction, stationIds, stopIds });
    }
  }

  // Keep both orientations (needed for last-train segment derivation); only
  // drop exact duplicate signatures.
  const seen = new Set<string>();
  const unique: Alignment[] = [];
  for (const a of alignments) {
    const sig = a.stationIds.join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(a);
  }

  const lines: LineEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const stops: StopEncoded[] = [];
  const stopById = new Map<string, StopEncoded>();

  const lineCodes = [...new Set(rows.map((r) => r.lineCode))].sort();
  const lineNameByCode = new Map(lineCodes.map((c) => [c, LINE_META[c]?.zh ?? c]));

  for (const code of lineCodes) {
    const meta = LINE_META[code] ?? {
      zh: code,
      en: code,
      color: '#666666',
      mode: 'metro' as const
    };
    const lineId = lineIdFor(code);
    lines.push({
      id: lineId,
      name: meta.zh,
      names: { zh: meta.zh, en: meta.en },
      aliases: [],
      color: meta.color,
      short_name: code,
      mode: meta.mode,
      status: 'operating',
      loop: false,
      source_ids: [{ source: MTR_SOURCE, id: code }],
      extras: { line_code: code }
    });

    const lineAlignments = unique.filter((a) => a.lineCode === code);
    // Longest alignment is the primary trunk; others are branches or reverses.
    const orderedAlignments = [...lineAlignments].sort(
      (a, b) => b.stationIds.length - a.stationIds.length
    );
    const primary = orderedAlignments[0];
    const primarySet = new Set(primary?.stationIds ?? []);
    const patternIdBySig = new Map<string, string>();

    for (const align of orderedAlignments) {
      const origin = align.stationIds[0];
      const terminal = align.stationIds[align.stationIds.length - 1];
      const sig = align.stationIds.join('|');
      const revSig = [...align.stationIds].reverse().join('|');
      const reverseOf = patternIdBySig.get(revSig);
      // Reverse alignments are not patterns (direction lives on timetable dests).
      if (reverseOf) continue;
      const isPrimary = align === primary;
      let junction: string | undefined;
      if (!isPrimary) {
        // Junction = first shared stop next to this alignment's unique portion.
        // - subset short-turn → origin
        // - border spur (Lo Wu / Lok Ma Chau via Sheung Shui) → first shared southbound
        // - lateral spur → shared stop after the unique run
        let lastUnique = -1;
        for (let i = 0; i < align.stationIds.length; i++) {
          if (!primarySet.has(align.stationIds[i]!)) lastUnique = i;
        }
        if (lastUnique < 0) {
          junction = align.stopIds[0];
        } else {
          for (let i = lastUnique + 1; i < align.stationIds.length; i++) {
            if (primarySet.has(align.stationIds[i]!)) {
              junction = align.stopIds[i];
              break;
            }
          }
          if (!junction) {
            for (let i = lastUnique - 1; i >= 0; i--) {
              if (primarySet.has(align.stationIds[i]!)) {
                junction = align.stopIds[i];
                break;
              }
            }
          }
        }
      }

      // Keep only the unique run + junction so multi-pattern overlap is a
      // single junction stop (verify: only the junction may be shared).
      let outStopIds = align.stopIds;
      let outStationIds = align.stationIds;
      if (!isPrimary && junction) {
        const jIdx = align.stopIds.indexOf(junction);
        if (jIdx >= 0) {
          const lastUnique = outStationIds.reduce(
            (acc, id, i) => (primarySet.has(id) ? acc : i),
            -1
          );
          if (lastUnique < 0) {
            // Subset short-turn: not a separate pattern at all.
            continue;
          }
          // Keep unique prefix/suffix through the junction.
          const lo = Math.min(lastUnique, jIdx);
          const hi = Math.max(lastUnique, jIdx);
          outStopIds = align.stopIds.slice(lo, hi + 1);
          outStationIds = align.stationIds.slice(lo, hi + 1);
          if (outStopIds.length < 2) continue;
        }
      }

      const patternId = `${lineId}-pattern-${readableSlug(origin.split('-').pop() ?? origin)}-to-${readableSlug(
        terminal.split('-').pop() ?? terminal
      )}`;
      const destName =
        physByFolded.get(foldFareName(terminal.replace(`${NETWORK_ID}-`, '')))?.en ??
        align.stationIds[align.stationIds.length - 1];

      patternIdBySig.set(sig, patternId);
      patterns.push({
        id: patternId,
        line_id: lineId,
        name: meta.zh,
        names: { zh: meta.zh, en: meta.en },
        stop_ids: outStopIds,
        origin_stop_id: outStopIds[0],
        terminal_stop_id: outStopIds[outStopIds.length - 1],
        is_primary: isPrimary,
        junction_stop_id: junction,
        color: meta.color,
        source_ids: [{ source: MTR_SOURCE, id: `${code}:${align.direction}` }],
        extras: {
          line_code: code,
          direction: align.direction,
          dest_name: destName,
          pattern_role: reverseOf ? 'reverse' : isPrimary ? 'direction' : 'branch',
          reverse_of: reverseOf
        }
      });

      const segmentKey = new Set<string>();
      for (let i = 0; i < outStopIds.length - 1; i++) {
        const a = outStopIds[i];
        const b = outStopIds[i + 1];
        const key = [lineId, a, b].sort().join('|');
        if (segmentKey.has(key)) continue;
        segmentKey.add(key);
        segments.push({
          id: `${NETWORK_ID}-seg-${a}-${b}`,
          line_id: lineId,
          from_stop_id: a,
          to_stop_id: b,
          from_station_id: outStationIds[i],
          to_station_id: outStationIds[i + 1],
          direction: 'both',
          source_id: MTR_SOURCE
        });
      }

      for (let i = 0; i < outStopIds.length; i++) {
        const stopId = outStopIds[i];
        if (stopById.has(stopId)) continue;
        const stop: StopEncoded = {
          id: stopId,
          station_id: outStationIds[i],
          line_id: lineId,
          // Provisional; renumbered uniquely per line below.
          sequence: i,
          is_terminal: i === 0 || i === align.stopIds.length - 1,
          source_id: align.direction ? `${code}:${align.direction}:${i}` : `${code}:${i}`,
          extras: { line_short_name: code }
        };
        stopById.set(stopId, stop);
        stops.push(stop);
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
    const sequenceByStop = new Map<string, number>();
    for (const p of ordered) {
      let next = lineNext.get(p.line_id) ?? 0;
      for (const stopId of p.stop_ids) {
        const stop = stopById.get(stopId);
        if (!stop || assigned.has(stop.id)) continue;
        sequenceByStop.set(stop.id, next++);
        assigned.add(stop.id);
      }
      lineNext.set(p.line_id, next);
    }
    for (const stop of stops) {
      const seq = sequenceByStop.get(stop.id);
      if (seq == null) continue;
      stopById.set(stop.id, { ...stop, sequence: seq });
    }
  }

  // Deduplicate segments that both directions emit.
  const segSeen = new Set<string>();
  const uniqueSegments: SegmentEncoded[] = [];
  for (const s of segments) {
    const key = [s.line_id, s.from_stop_id, s.to_stop_id].sort().join('|');
    if (segSeen.has(key)) continue;
    segSeen.add(key);
    uniqueSegments.push(s);
  }

  const usedStopStationIds = new Set([...stopById.values()].map((s) => s.station_id));
  const stations: StationEncoded[] = [];
  for (const phys of physByFolded.values()) {
    if (!usedStopStationIds.has(phys.id)) continue;
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en },
      status: 'operating',
      source_ids: [
        ...phys.sourceIds.map((id) => ({ source: MTR_SOURCE, id })),
        { source: MTR_SOURCE, id: phys.en }
      ],
      extras: {
        mtr_station_ids: phys.sourceIds,
        lines: [...phys.lineCodes].sort(),
        names_source: 'source'
      }
    });
  }

  const stationIdByFoldedName = new Map<string, string>();
  const enByStationId = new Map<string, string>();
  for (const phys of physByFolded.values()) {
    if (!usedStopStationIds.has(phys.id)) continue;
    stationIdByFoldedName.set(foldFareName(phys.en), phys.id);
    enByStationId.set(phys.id, phys.en);
  }

  // Match AMap by English name: AMap publishes simplified Chinese, MTR traditional.
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const amapByFoldedEn = new Map<string, { lon: number; lat: number }>();
  for (const a of sources.amapStations) {
    const k = foldEn(a.en);
    if (!amapByFoldedEn.has(k)) amapByFoldedEn.set(k, { lon: a.lon, lat: a.lat });
  }
  for (const [id, en] of enByStationId) {
    const key = foldEn(en);
    const hit =
      amapByFoldedEn.get(key) ??
      amapByFoldedEn.get(EN_NAME_ALIASES[key] ?? '') ??
      [...amapByFoldedEn.entries()].find(
        ([k]) => (key.length >= 3 && (k.startsWith(key) || k.includes(key))) || k === key
      )?.[1];
    if (hit) {
      officialLocations.set(id, { lon: hit.lon, lat: hit.lat, crs: 'gcj02' });
    }
  }

  const fares = buildFareMatrix({
    networkId: NETWORK_ID,
    stationIds: stations.map((s) => s.id).sort(),
    stationIdByFoldedName,
    fares: sources.fares,
    airportExpressFares: sources.airportExpressFares
  });

  // ---- Timetables from official service-hours pages -------------------------
  // Each MTR Station ID (including AEL platform ids) has its own page; map
  // source id -> (phys station, line) via the alignment rows we already have.
  const srcToPhys = new Map<string, string>();
  for (const row of rows) {
    srcToPhys.set(row.stationId, stationIdToPhys.get(row.stationId) ?? '');
  }
  const stopByPhysLine = new Map<string, string>();
  for (const s of stopById.values()) {
    const meta = s.extras?.line_short_name as string | undefined;
    if (meta) stopByPhysLine.set(`${s.station_id}|${meta}`, s.id);
  }
  const patternByLine = new Map<string, PatternEncoded[]>();
  for (const p of patterns) {
    const list = patternByLine.get(p.line_id) ?? [];
    list.push(p);
    patternByLine.set(p.line_id, list);
  }
  /** Ordered stop path covering origin→dest on one line, stitching patterns if needed. */
  function resolveStopPath(originStopId: string, destStopId: string): string[] | undefined {
    const list = patterns.filter(
      (p) => p.stop_ids.includes(originStopId) && p.stop_ids.includes(destStopId)
    );
    const direct = list.find((p) => p.terminal_stop_id === destStopId) ?? list[0];
    if (direct) return [...direct.stop_ids];
    // Through-running services (e.g. LOHAS Park → North Point) span a branch and
    // the trunk. Stitch at the deepest shared stop of origin's and dest's patterns.
    const fromP = patterns.find((p) => p.stop_ids.includes(originStopId));
    const toP = patterns.find((p) => p.stop_ids.includes(destStopId));
    if (!fromP || !toP) return undefined;
    const toSet = new Set(toP.stop_ids);
    let junction = -1;
    for (let i = fromP.stop_ids.length - 1; i >= 0; i--) {
      if (toSet.has(fromP.stop_ids[i]!)) {
        junction = i;
        break;
      }
    }
    if (junction < 0) return undefined;
    const jStop = fromP.stop_ids[junction]!;
    const jTo = toP.stop_ids.indexOf(jStop);
    if (jTo < 0) return undefined;
    const path = [...fromP.stop_ids.slice(0, junction + 1), ...toP.stop_ids.slice(jTo + 1)];
    if (!path.includes(originStopId) || !path.includes(destStopId)) return undefined;
    return path;
  }

  function pickPattern(
    lineCode: string,
    originStopId: string,
    destStopId: string
  ): PatternEncoded | undefined {
    const lineId = lineIdFor(lineCode);
    const list = patternByLine.get(lineId) ?? [];
    const both = list.find(
      (p) => p.stop_ids.includes(originStopId) && p.stop_ids.includes(destStopId)
    );
    if (both) {
      return (
        list.find(
          (p) =>
            p.stop_ids.includes(originStopId) &&
            p.stop_ids.includes(destStopId) &&
            p.terminal_stop_id === destStopId
        ) ?? both
      );
    }
    // Build / reuse a through pattern so dest lies on the same pattern as origin.
    const path = resolveStopPath(originStopId, destStopId);
    if (!path) return undefined;
    const pathSig = path.join('|');
    const existing = patterns.find((p) => p.line_id === lineId && p.stop_ids.join('|') === pathSig);
    if (existing) return existing;
    const patternId = `${lineId}-pattern-${readableSlug(originStopId.split('-').pop() ?? '')}-to-${readableSlug(
      destStopId.split('-').pop() ?? ''
    )}-through`;
    const created: PatternEncoded = {
      id: patternId,
      line_id: lineId,
      name: lineNameByCode.get(lineCode) ?? lineCode,
      names: undefined,
      stop_ids: path,
      origin_stop_id: path[0]!,
      terminal_stop_id: path[path.length - 1]!,
      is_primary: false,
      source_ids: [{ source: 'mtr-service-hours', id: `${originStopId}->${destStopId}` }],
      extras: { line_code: lineCode, pattern_role: 'through' }
    };
    patterns.push(created);
    const bucket = patternByLine.get(lineId) ?? [];
    bucket.push(created);
    patternByLine.set(lineId, bucket);
    return created;
  }

  function hhmm(raw: string): string {
    const t = raw.trim();
    if (!/^\d{4}$/.test(t)) return '';
    return `${t.slice(0, 2)}:${t.slice(2)}`;
  }

  const timetables: TimetableEncoded[] = [];
  const ttIds = new Set<string>();
  for (const [srcId, shRows] of sources.serviceHours) {
    const originPhysId = srcToPhys.get(srcId);
    if (!originPhysId) continue;
    for (const row of shRows) {
      const destPhysId = srcToPhys.get(row.destStationId);
      if (!destPhysId) continue;
      const originStopId = stopByPhysLine.get(`${originPhysId}|${row.lineCode}`);
      const destStopId = stopByPhysLine.get(`${destPhysId}|${row.lineCode}`);
      if (!originStopId || !destStopId || originStopId === destStopId) continue;
      const pattern = pickPattern(row.lineCode, originStopId, destStopId);
      if (!pattern) continue;
      const id = `${NETWORK_ID}-${originStopId}-to-${destStopId}`;
      if (ttIds.has(id)) continue;
      ttIds.add(id);
      const first = hhmm(row.first);
      const last = hhmm(row.last);
      if (!first && !last) continue;
      timetables.push({
        id,
        station_id: originPhysId,
        stop_id: originStopId,
        line_id: lineIdFor(row.lineCode),
        station_code: srcId,
        source_id: 'mtr-service-hours',
        destination_stop_id: destStopId,
        origin_stop_id: pattern.origin_stop_id,
        pattern_id: pattern.id,
        direction_type: 'linear',
        direction_label: `往${destPhysId.replace(`${NETWORK_ID}-`, '')}`,
        first_train: first ? [first] : [],
        last_train: last ? [last] : [],
        service: 'all_days',
        extras: {
          line_code: row.lineCode,
          mtr_origin_id: srcId,
          mtr_dest_id: row.destStationId,
          source_first: row.first,
          source_last: row.last
        }
      });
    }
  }

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '港鐵',
    names: { zh: '港鐵', en: 'Mass Transit Railway (Hong Kong)' },
    city: placeholderCity('CN-81'),
    country_code: 'CN',
    currency: 'HKD',
    timezone: 'Asia/Hong_Kong',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      '拓扑与中英文站名来自 MTR 开放数据 mtr_lines_and_stations.csv；首末班来自官网 service_hours_search.php；票价矩阵来自 mtr_lines_fares.csv + airport_express_fares.csv（成人八达通）。区间时分由末班车链推导。轻铁与巴士不在本网络内。坐标由 geocode 链补齐（GCJ-02）。'
  };

  return {
    network,
    lines,
    stations: stations.sort((a, b) => a.id.localeCompare(b.id)),
    stops: [...stopById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    segments: uniqueSegments.sort((a, b) => a.id.localeCompare(b.id)),
    transfers: [],
    timetables: timetables.sort((a, b) => a.id.localeCompare(b.id)),
    fares,
    officialLocations
  };
}
