import type {
  FareMatrixEncoded,
  LineEncoded,
  NetworkEncoded,
  PatternEncoded,
  SegmentEncoded,
  StationEncoded,
  StopEncoded,
  TimetableEncoded
} from '@openmetro/core';
import { placeholderCity, readableSlug, stationIdFor } from '@openmetro/core';
import { buildFareMatrix, type FareRules, foldStationName } from './fares.js';
import type { MlmLine, MlmSources } from './fetch.js';
import { buildVerifiedTimes, toWeekArray } from './timetables.js';

const NETWORK_ID = 'cn-macau';

export interface MacauCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  timetables: TimetableEncoded[];
  fares: FareMatrixEncoded;
}

function foldEn(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[''`']/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function stopIdFor(stationId: string, lineKey: string): string {
  return `${stationId}-${lineKey}`;
}

function lineIdFor(lineKey: string): string {
  return `${NETWORK_ID}-line-${lineKey}`;
}

/** Short display name: drop trailing 線/Line. */
function shortNameOf(line: MlmLine): string {
  return line.zh.replace(/線$|线$/, '') || line.key;
}

export function normalizeMacau(sources: MlmSources): MacauCanonical {
  // ---- Match official Chinese names to AMap stations (GCJ-02 coords) ----
  const amapByFolded = new Map<string, { lon: number; lat: number }>();
  for (const st of sources.amap.stations) {
    for (const n of [st.zh, st.zhHant, st.en]) {
      if (!n) continue;
      for (const k of [foldStationName(n), foldEn(n)]) {
        if (k && !amapByFolded.has(k)) {
          amapByFolded.set(k, { lon: st.lon, lat: st.lat });
        }
      }
    }
  }

  const stationIdByZh = new Map<string, string>();
  const zhByStationId = new Map<string, string>();
  const enByStationId = new Map<string, string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();

  for (const st of sources.stations) {
    const id = stationIdFor(st.en, st.zh);
    stationIdByZh.set(st.zh, id);
    zhByStationId.set(id, st.zh);
    enByStationId.set(id, st.en);
    const hit =
      amapByFolded.get(foldStationName(st.zh)) ??
      amapByFolded.get(foldEn(st.en)) ??
      amapByFolded.get(foldStationName(st.en));
    if (hit) {
      officialLocations.set(id, { lon: hit.lon, lat: hit.lat, crs: 'gcj02' });
    }
  }

  // ---- Lines / patterns / stops / segments ----
  const lines: LineEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const stops: StopEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const stopById = new Map<string, StopEncoded>();

  for (const line of sources.lines) {
    const lineId = lineIdFor(line.key);
    lines.push({
      id: lineId,
      name: line.zh,
      names: { zh: line.zh, en: line.en },
      aliases: [],
      color: line.color,
      short_name: shortNameOf(line),
      mode: 'light_rail',
      status: 'operating',
      loop: false,
      source_ids: [{ source: 'mlm-route', id: line.key }],
      extras: {
        line_key: line.key,
        color_source: 'mlm-route-legend',
        service: line.service
      }
    });

    const order = line.stationsZh;
    const forwardStops: string[] = [];
    const forwardStations: string[] = [];

    for (let i = 0; i < order.length; i++) {
      const zh = order[i]!;
      const stId = stationIdByZh.get(zh);
      if (!stId) continue;
      const sId = stopIdFor(stId, line.key);
      forwardStops.push(sId);
      forwardStations.push(stId);
      if (!stopById.has(sId)) {
        const loc = officialLocations.get(stId);
        const stop: StopEncoded = {
          id: sId,
          station_id: stId,
          line_id: lineId,
          sequence: i,
          is_terminal: i === 0 || i === order.length - 1,
          location: loc ? { lon: loc.lon, lat: loc.lat, crs: 'gcj02' } : undefined,
          source_id: `mlm:${line.key}:${i}`,
          extras: { line_key: line.key }
        };
        stopById.set(sId, stop);
        stops.push(stop);
      }
    }

    const originZh = order[0]!;
    const termZh = order[order.length - 1]!;
    const patternId = `${lineId}-pattern-${readableSlug(
      enByStationId.get(forwardStations[0] ?? '') ?? originZh
    )}-to-${readableSlug(enByStationId.get(forwardStations[forwardStations.length - 1] ?? '') ?? termZh)}`;

    patterns.push({
      id: patternId,
      line_id: lineId,
      name: line.zh,
      names: { zh: line.zh, en: line.en },
      stop_ids: forwardStops,
      origin_stop_id: forwardStops[0]!,
      terminal_stop_id: forwardStops[forwardStops.length - 1]!,
      is_primary: true,
      color: line.color,
      source_ids: [{ source: 'mlm-route', id: line.key }],
      extras: {
        line_key: line.key,
        direction: 'down',
        dest_name: enByStationId.get(forwardStations[forwardStations.length - 1] ?? '') ?? termZh
      }
    });

    const segSeen = new Set<string>();
    for (let i = 0; i < forwardStops.length - 1; i++) {
      const a = forwardStops[i]!;
      const b = forwardStops[i + 1]!;
      const sk = [lineId, a, b].sort().join('|');
      if (segSeen.has(sk)) continue;
      segSeen.add(sk);
      segments.push({
        id: `${NETWORK_ID}-seg-${a}-${b}`,
        line_id: lineId,
        from_stop_id: a,
        to_stop_id: b,
        from_station_id: forwardStations[i]!,
        to_station_id: forwardStations[i + 1]!,
        direction: 'both',
        source_id: 'mlm-route'
      });
    }
  }

  // ---- Stations ----
  const stations: StationEncoded[] = [];
  for (const st of sources.stations) {
    const id = stationIdByZh.get(st.zh);
    if (!id) continue;
    const loc = officialLocations.get(id);
    stations.push({
      id,
      name: st.zh,
      names: { zh: st.zh, en: st.en },
      location: loc ? { lon: loc.lon, lat: loc.lat, crs: 'gcj02' } : undefined,
      status: 'operating',
      source_ids: [
        { source: 'mlm-route', id: st.zh },
        { source: 'amap-subway-8200', id: st.zh }
      ],
      extras: {
        tt_code: st.ttCode,
        tt_image: st.ttImageUrl,
        lines: st.lines,
        names_source: 'mlm',
        location_source: loc ? 'amap' : undefined
      }
    });
  }

  // ---- Timetables (hand-maintained first/last; see timetables.ts) ----
  const verified = buildVerifiedTimes();
  const patternByLineKey = new Map<string, PatternEncoded>();
  for (const p of patterns) {
    const lk = (p.extras as { line_key?: string })?.line_key;
    if (lk) patternByLineKey.set(lk, p);
  }

  const lineKeyOfZh = (zh: string): string => {
    for (const line of sources.lines) {
      if (line.stationsZh.includes(zh)) return line.key;
    }
    return 'taipa';
  };

  const timetables: TimetableEncoded[] = [];
  for (const row of verified) {
    const fromId = stationIdByZh.get(row.fromZh);
    const toId = stationIdByZh.get(row.toZh);
    if (!fromId || !toId) continue;
    const lk = lineKeyOfZh(row.fromZh);
    const line = sources.lines.find((l) => l.key === lk);
    if (!line) continue;
    const order = line.stationsZh;
    const termZh = order[order.length - 1]!;
    const originZh = order[0]!;
    const isDown = row.toZh === termZh;
    const isUp = row.toZh === originZh;
    if (!isDown && !isUp) continue;
    // Reverse is not a separate pattern; both directions share the primary stop path.
    const pattern = patternByLineKey.get(lk);
    if (!pattern) continue;
    const stopId = stopIdFor(fromId, lk);
    const destStopId = stopIdFor(toId, lk);
    if (!pattern.stop_ids.includes(stopId) || !pattern.stop_ids.includes(destStopId)) continue;

    const dayTimes = {
      mon_thu: row.mon_thu,
      fri: row.fri,
      sat_sun_hol: row.sat_sun_hol
    };

    timetables.push({
      id: `${NETWORK_ID}-tt-${stopId}-${isDown ? 'down' : 'up'}`,
      station_id: fromId,
      stop_id: stopId,
      line_id: lineIdFor(lk),
      source_id: 'mlm-timetable-derived',
      destination_stop_id: destStopId,
      pattern_id: pattern.id,
      direction_type: 'linear',
      direction_label: isDown ? 'down' : 'up',
      first_train: toWeekArray(dayTimes, 'first'),
      last_train: toWeekArray(dayTimes, 'last'),
      extras: {
        tt_code: row.ttCode,
        dest_zh: row.toZh,
        note: row.note,
        day_types: dayTimes
      }
    });
  }

  // ---- Fares (parsed station-count rules) ----
  const rules: FareRules = {
    tiers: sources.fareTiers,
    seaCrossingPairs: sources.seaCrossingPairs,
    endpointOnlyStations: sources.endpointOnlyStations
  };
  const fares = buildFareMatrix({
    stationIds: stations.map((s) => s.id).sort(),
    zhByStationId,
    lineStations: sources.lines.map((l) => ({ line: l.key, stations: l.stationsZh })),
    rules
  });

  const network: NetworkEncoded = {
    id: NETWORK_ID,
    name: '澳門輕軌',
    names: { zh: '澳門輕軌', en: 'Macau Light Rapid Transit' },
    city: placeholderCity('CN-82'),
    country_code: 'MO',
    currency: 'MOP',
    timezone: 'Asia/Macau',
    coordinate_system: 'gcj02',
    default_units: { distance: 'km', time: 's', speed: 'km/h' },
    routing: {
      weight: 'time',
      default_transfer_seconds: 120,
      max_transfer_seconds: 600
    },
    notes:
      'Colors/names/topology/fares parsed from mlm.com.mo; coordinates from AMap subway 8200 (GCJ-02); first/last from verified timetable sheets + derived runtimes.'
  };

  return { network, lines, stations, stops, patterns, segments, timetables, fares };
}
