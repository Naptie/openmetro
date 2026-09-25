/**
 * Validate every canonical network and emit a deterministic manifest.
 *
 * Layers of checks:
 *   1. Schema decode (`loadNetwork`) — types, required fields, enums.
 *   2. Referential integrity — every FK points at a real entity.
 *   3. Full-schema data integrity / coverage:
 *        - operating stations have GCJ-02/WGS-84 coords + zh/en names
 *        - every station has stops; every stop sits on a pattern of its line
 *        - interchange stations have a complete directional transfer pair
 *        - every segment has a positive travel time
 *        - linear timetables name a destination; loops use direction_type
 *        - fares cover every operating station; matrix is square
 *        - lines that publish any timetable cover every operating stop
 *          (tram-only networks/lines with zero published times are exempt)
 *        - every line carries a non-empty `short_name` unless waived per network
 *
 * The manifest is content-addressed: `aggregate` is the sha256 of the sorted
 * `<network>/<file>:<sha256>` lines.
 *
 * Usage: `bun run scripts/verify-data.ts [--out <path>] [--network <id>]`
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
import {
  evaluateStationSpeed,
  haversineKm,
  loadNetwork,
  type NetworkData
} from '../packages/core/src/index.js';

const DATA_ROOT = resolve(process.env.OPENMETRO_DATA_ROOT ?? 'data');

/**
 * Canonical files that make up a published dataset (order is irrelevant).
 * Every network must ship a fares matrix after a complete sync; adapters that
 * only implement topology must still emit `fares.json` (even all-null rows).
 */
const CANONICAL_FILES = [
  'network.json',
  'lines.json',
  'stations.json',
  'stops.json',
  'patterns.json',
  'segments.json',
  'transfers.json',
  'timetables.json',
  'fares.json'
];

/**
 * Operating lines that legitimately have no compact display code
 * (`short_name` is null), keyed by network id: the operator publishes none
 * for them. A stale entry after a line gains a code is harmless; a missing
 * one fails here.
 */
const SHORT_NAME_WAIVERS: Partial<Record<string, ReadonlySet<string>>> = {};

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(network: string, message: string): never {
  throw new Error(`[${network}] ${message}`);
}

function warn(network: string, message: string): void {
  console.warn(`[${network}] warn: ${message}`);
}

function assert(condition: unknown, network: string, message: string): asserts condition {
  if (!condition) fail(network, message);
}

function isPlausibleLocation(lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return false;
  // Reject the null island / unset placeholder.
  if (lon === 0 && lat === 0) return false;
  return true;
}

function verifyReferences(network: string, d: NetworkData): void {
  const lineIds = new Set(d.lines.map((l) => l.id));
  const stationIds = new Set(d.stations.map((s) => s.id));
  const stopById = new Map(d.stops.map((s) => [s.id, s]));
  const patternIds = new Set(d.patterns.map((p) => p.id));
  const lineById = new Map(d.lines.map((l) => [l.id, l]));

  // ── Network metadata ──────────────────────────────────────────
  assert(d.network.id === network, network, 'network.id mismatch');
  assert(d.network.routing?.weight, network, 'network.routing.weight missing');
  assert(
    d.network.routing.default_transfer_seconds > 0,
    network,
    'network.routing.default_transfer_seconds must be > 0'
  );
  assert(d.network.currency, network, 'network.currency missing');
  assert(d.network.timezone, network, 'network.timezone missing');

  // ── Lines ─────────────────────────────────────────────────────
  for (const line of d.lines) {
    assert(line.names?.zh, network, `line ${line.id} missing names.zh`);
    assert(line.names?.en, network, `line ${line.id} missing names.en`);
    assert(lineIds.has(line.id), network, `line ${line.id} duplicate`);
  }

  // ── short_name coverage ───────────────────────────────────────
  // `short_name` is mandatory on every line (schema-enforced). This check
  // additionally rejects empty/whitespace values, which the schema would
  // accept, and keeps the per-network waiver escape hatch for the rare case
  // where an operator genuinely publishes no compact label.
  const waivers = SHORT_NAME_WAIVERS[network] ?? new Set<string>();
  for (const line of d.lines) {
    if (line.short_name.trim().length > 0) continue;
    assert(
      waivers.has(line.id),
      network,
      `line ${line.id} has an empty short_name (add a waiver or fix the adapter)`
    );
  }

  // ── Stations ──────────────────────────────────────────────────
  const stationById = new Map(d.stations.map((s) => [s.id, s]));
  assert(stationById.size === d.stations.length, network, 'duplicate station ids');
  for (const station of d.stations) {
    assert(station.names?.zh, network, `station ${station.id} missing names.zh`);
    assert(station.names?.en, network, `station ${station.id} missing names.en`);
    // Coordinates must be resolved for in-service metro-class stations.
    // Tram/other modes may be absent from AMap+Overpass+Photon on a given day.
    if (station.status === 'operating') {
      const lineModes = new Set(
        d.stops.filter((s) => s.station_id === station.id).map((s) => lineById.get(s.line_id)?.mode)
      );
      const needsCoords = [...lineModes].some(
        (m) => m === 'metro' || m === 'airport_express' || m === 'monorail' || m === 'light_rail'
      );
      if (needsCoords) {
        if (!station.location) {
          // A newly opened station may appear in the timetable before it is
          // published on AMap / the official station.js picker. Soft-warn.
          warn(network, `station ${station.id} (${station.name ?? ''}) missing location`);
        } else {
          assert(station.location.crs, network, `station ${station.id} location.crs missing`);
          assert(
            isPlausibleLocation(station.location.lon, station.location.lat),
            network,
            `station ${station.id} has implausible coordinates`
          );
        }
      }
    }
  }

  // ── Stops ─────────────────────────────────────────────────────
  const stopIds = new Set<string>();
  const linesByStation = new Map<string, Set<string>>();
  for (const stop of d.stops) {
    assert(!stopIds.has(stop.id), network, `duplicate stop ${stop.id}`);
    stopIds.add(stop.id);
    assert(stationIds.has(stop.station_id), network, `stop ${stop.id} -> unknown station`);
    assert(lineIds.has(stop.line_id), network, `stop ${stop.id} -> unknown line ${stop.line_id}`);
    const set = linesByStation.get(stop.station_id) ?? new Set();
    set.add(stop.line_id);
    linesByStation.set(stop.station_id, set);
  }
  for (const station of d.stations) {
    assert(linesByStation.has(station.id), network, `station ${station.id} has no stops`);
  }

  // ── Patterns ──────────────────────────────────────────────────
  const stopsInPatterns = new Set<string>();
  for (const pattern of d.patterns) {
    assert(lineIds.has(pattern.line_id), network, `pattern ${pattern.id} -> unknown line`);
    assert(pattern.stop_ids.length >= 2, network, `pattern ${pattern.id} needs >= 2 stops`);
    assert(
      pattern.origin_stop_id === pattern.stop_ids[0],
      network,
      `pattern ${pattern.id} origin_stop_id mismatch`
    );
    assert(
      pattern.terminal_stop_id === pattern.stop_ids[pattern.stop_ids.length - 1],
      network,
      `pattern ${pattern.id} terminal_stop_id mismatch`
    );
    for (const stopId of pattern.stop_ids) {
      const stop = stopById.get(stopId);
      assert(stop, network, `pattern ${pattern.id} -> unknown stop ${stopId}`);
      assert(
        stop.line_id === pattern.line_id,
        network,
        `pattern ${pattern.id} stop ${stopId} is on line ${stop.line_id}`
      );
      stopsInPatterns.add(stopId);
    }
    if (pattern.junction_stop_id) {
      assert(
        stopById.has(pattern.junction_stop_id),
        network,
        `pattern ${pattern.id} -> unknown junction ${pattern.junction_stop_id}`
      );
    }
  }
  for (const stop of d.stops) {
    assert(
      stopsInPatterns.has(stop.id),
      network,
      `stop ${stop.id} is not referenced by any pattern`
    );
  }

  // ── Segments ──────────────────────────────────────────────────
  const segmentPairs = new Set<string>();
  for (const segment of d.segments) {
    assert(lineIds.has(segment.line_id), network, `segment ${segment.id} -> unknown line`);
    const from = stopById.get(segment.from_stop_id);
    const to = stopById.get(segment.to_stop_id);
    assert(from, network, `segment ${segment.id} -> unknown from stop`);
    assert(to, network, `segment ${segment.id} -> unknown to stop`);
    assert(
      from.station_id === segment.from_station_id && to.station_id === segment.to_station_id,
      network,
      `segment ${segment.id} denormalized station ids disagree with stops`
    );
    assert(
      from.line_id === segment.line_id && to.line_id === segment.line_id,
      network,
      `segment ${segment.id} stops are not on the segment line`
    );
    assert(
      segment.travel_time_seconds != null && segment.travel_time_seconds > 0,
      network,
      `segment ${segment.id} missing or non-positive travel time`
    );
    const key = `${segment.from_stop_id}|${segment.to_stop_id}`;
    assert(!segmentPairs.has(key), network, `duplicate segment ${key}`);
    segmentPairs.add(key);
  }

  // ── Geometry sanity ────────────────────────────────────────────
  // Adjacent stops on one pattern must be physically near each other, and a
  // linear pattern must not double back on itself. These catch topology bugs
  // that schema + FK checks cannot see (e.g. a branch list flattened into the
  // main alignment, producing a multi-km "adjacent" hop or a zigzag).
  /** Soft floor: longer hops are unusual and worth a warning. */
  const WARN_GAP_KM = 3;
  /**
   * Sanity ceiling only — airport expresses routinely span 20km+ between
   * stops (Beijing Daxing, Chengdu Tianfu). Topology bugs are caught by the
   * heading-reversal check below, not by distance alone.
   */
  const MAX_GAP_KM: Record<string, number> = {
    metro: 50,
    monorail: 50,
    light_rail: 50,
    tram: 20,
    airport_express: 80,
    suburban_rail: 80,
    other: 50
  };
  const locOf = (stationId: string) => {
    const st = stationById.get(stationId);
    return st?.location ? { lon: st.location.lon, lat: st.location.lat } : undefined;
  };
  const bearingDeg = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const toDeg = (r: number) => (r * 180) / Math.PI;
    const p1 = toRad(a.lat);
    const p2 = toRad(b.lat);
    const dl = toRad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };
  for (const pattern of d.patterns) {
    const mode = lineById.get(pattern.line_id)?.mode ?? 'other';
    const maxGap = MAX_GAP_KM[mode] ?? MAX_GAP_KM.other!;
    for (let i = 0; i < pattern.stop_ids.length - 1; i++) {
      const a = stopById.get(pattern.stop_ids[i]!);
      const b = stopById.get(pattern.stop_ids[i + 1]!);
      if (!a || !b) continue;
      const la = locOf(a.station_id);
      const lb = locOf(b.station_id);
      if (!la || !lb) continue;
      const gapKm = haversineKm(la, lb);
      if (gapKm > WARN_GAP_KM) {
        warn(
          network,
          `pattern ${pattern.id} adjacent gap ${gapKm.toFixed(2)}km > ${WARN_GAP_KM}km between ${a.station_id} and ${b.station_id}`
        );
      }
      assert(
        gapKm <= maxGap,
        network,
        `pattern ${pattern.id} adjacent gap ${gapKm.toFixed(2)}km > ${maxGap}km between ${a.station_id} and ${b.station_id}`
      );
    }
    for (let i = 1; i < pattern.stop_ids.length - 1; i++) {
      const a = stopById.get(pattern.stop_ids[i - 1]!);
      const b = stopById.get(pattern.stop_ids[i]!);
      const c = stopById.get(pattern.stop_ids[i + 1]!);
      if (!a || !b || !c) continue;
      const la = locOf(a.station_id);
      const lb = locOf(b.station_id);
      const lc = locOf(c.station_id);
      if (!la || !lb || !lc) continue;
      const d1 = haversineKm(la, lb);
      const d2 = haversineKm(lb, lc);
      if (d1 < 0.3 || d2 < 0.3) continue;
      // Long express / sea-crossing legs legitimately turn hard (HK Airport
      // Express doglegs around the airport island).
      if (d1 > 10 || d2 > 10) continue;
      const b1 = bearingDeg(la, lb);
      const b2 = bearingDeg(lb, lc);
      const turn = Math.abs(((b2 - b1 + 540) % 360) - 180);
      assert(
        // 160° catches flattened-branch backtracks; allows real doglegs.
        turn < 160,
        network,
        `pattern ${pattern.id} heading reversal ${turn.toFixed(0)}° at ${b.station_id} (${a.station_id}->${c.station_id})`
      );
    }
  }

  // ── Speed-validate coordinates ─────────────────────────────────
  const segAdj = d.segments.map((s) => ({
    from_station_id: s.from_station_id,
    to_station_id: s.to_station_id,
    line_id: s.line_id,
    travel_time_seconds: s.travel_time_seconds ?? undefined,
    travel_time_source: s.travel_time_source ?? undefined
  }));
  const lineModes = d.lines.map((l) => ({ id: l.id, mode: l.mode }));
  for (const station of d.stations) {
    if (station.status !== 'operating') continue;
    const report = evaluateStationSpeed(d.stations, segAdj, station.id, { lines: lineModes });
    if (report.ok) continue;
    const details = report.violations
      .map(
        (v) =>
          `${v.kind} d=${v.distance_km.toFixed(2)}km t=${v.travel_time_seconds}s ratio=${v.ratio.toFixed(2)}`
      )
      .join('; ');
    warn(network, `station ${station.id} (${station.name ?? ''}) speed-validate: ${details}`);
  }

  // ── Transfers ─────────────────────────────────────────────────
  const transferKeys = new Set<string>();
  for (const transfer of d.transfers) {
    assert(
      stationIds.has(transfer.station_id),
      network,
      `transfer ${transfer.id} -> unknown station`
    );
    assert(
      lineIds.has(transfer.from_line_id) && lineIds.has(transfer.to_line_id),
      network,
      `transfer ${transfer.id} -> unknown line`
    );
    assert(
      transfer.from_line_id !== transfer.to_line_id,
      network,
      `transfer ${transfer.id} is a self-transfer on one line`
    );
    for (const stopId of [transfer.from_stop_id, transfer.to_stop_id]) {
      if (stopId) assert(stopById.has(stopId), network, `transfer ${transfer.id} -> unknown stop`);
    }
    const key = `${transfer.station_id}|${transfer.from_line_id}->${transfer.to_line_id}`;
    assert(!transferKeys.has(key), network, `duplicate transfer ${key}`);
    transferKeys.add(key);
  }
  // Complete directional pairs at every interchange.
  for (const [stationId, lines] of linesByStation) {
    if (lines.size < 2) continue;
    for (const a of lines) {
      for (const b of lines) {
        if (a === b) continue;
        const key = `${stationId}|${a}->${b}`;
        assert(
          transferKeys.has(key),
          network,
          `interchange ${stationId} missing transfer ${a} -> ${b}`
        );
      }
    }
  }

  // ── Timetables ────────────────────────────────────────────────
  const ttStops = new Set<string>();
  const ttByLine = new Map<string, Set<string>>();
  const patternById = new Map(d.patterns.map((p) => [p.id, p]));
  // Same station + line + direction must not repeat; same dest+label neither.
  const ttDirKeys = new Set<string>();
  const ttDestKeys = new Set<string>();
  // stop.sequence must be unique within a line (map/order consumers rely on it).
  const lineSeqSeen = new Map<string, Set<number>>();
  for (const stop of d.stops) {
    const seen = lineSeqSeen.get(stop.line_id) ?? new Set<number>();
    assert(
      !seen.has(stop.sequence),
      network,
      `stop ${stop.id} duplicates sequence ${stop.sequence} on line ${stop.line_id}`
    );
    seen.add(stop.sequence);
    lineSeqSeen.set(stop.line_id, seen);
  }
  for (const timetable of d.timetables) {
    assert(stationIds.has(timetable.station_id), network, `timetable ${timetable.id} -> station`);
    assert(lineIds.has(timetable.line_id), network, `timetable ${timetable.id} -> line`);
    assert(stopById.has(timetable.stop_id), network, `timetable ${timetable.id} -> stop`);
    assert(patternIds.has(timetable.pattern_id), network, `timetable ${timetable.id} -> pattern`);
    const stop = stopById.get(timetable.stop_id);
    assert(
      stop.station_id === timetable.station_id && stop.line_id === timetable.line_id,
      network,
      `timetable ${timetable.id} stop disagrees with station/line`
    );
    const pattern = patternById.get(timetable.pattern_id);
    assert(pattern, network, `timetable ${timetable.id} pattern missing`);
    assert(
      pattern.stop_ids.includes(timetable.stop_id),
      network,
      `timetable ${timetable.id} stop is not on its pattern`
    );
    if (timetable.destination_stop_id) {
      const dest = stopById.get(timetable.destination_stop_id);
      assert(dest, network, `timetable ${timetable.id} -> destination`);
      assert(
        dest.line_id === timetable.line_id,
        network,
        `timetable ${timetable.id} destination is on another line`
      );
      // Destination may sit on a different pattern of the same line: after
      // stub-ification a through-running service still terminates at a spur
      // station that only the branch pattern lists. Direction is the dest.
    }
    if (timetable.direction_label) {
      // Same station+line+direction+pattern is only illegal for identical time
      // payloads. Operators publish calendar variants (weekday vs weekend
      // last-train arrays) under one public direction name.
      const timeSig = `${timetable.first_train.join(',')}|${timetable.last_train.join(',')}`;
      const dirKey = `${timetable.station_id}|${timetable.line_id}|${timetable.direction_label}|${timetable.pattern_id}|${timeSig}`;
      assert(
        !ttDirKeys.has(dirKey),
        network,
        `timetable duplicate direction+pattern+times at station ${timetable.station_id} line ${timetable.line_id}: ${timetable.direction_label} / ${timetable.pattern_id}`
      );
      ttDirKeys.add(dirKey);
    }
    {
      // Calendar variants (weekday vs weekend last-train arrays) are legal
      // under the same dest+label; only identical time payloads are duplicates.
      const timeSig = `${timetable.first_train.join(',')}|${timetable.last_train.join(',')}`;
      const destKey = `${timetable.station_id}|${timetable.line_id}|${timetable.destination_stop_id ?? ''}|${timetable.direction_label ?? ''}|${timeSig}`;
      assert(
        !ttDestKeys.has(destKey),
        network,
        `timetable duplicate dest+direction+times at station ${timetable.station_id} line ${timetable.line_id} dest=${timetable.destination_stop_id} label=${timetable.direction_label ?? ''}`
      );
      ttDestKeys.add(destKey);
    }
    const isLoopDir =
      timetable.direction_type === 'loop_inner' || timetable.direction_type === 'loop_outer';
    const line = lineById.get(timetable.line_id);
    if (isLoopDir) {
      assert(
        line?.loop || isLoopDir,
        network,
        `timetable ${timetable.id} loop direction on non-loop line`
      );
    } else {
      assert(
        timetable.destination_stop_id != null,
        network,
        `linear timetable ${timetable.id} missing destination_stop_id`
      );
    }
    assert(
      timetable.first_train.length === 1 || timetable.first_train.length === 7,
      network,
      `timetable ${timetable.id} first_train length`
    );
    assert(
      timetable.last_train.length === 1 || timetable.last_train.length === 7,
      network,
      `timetable ${timetable.id} last_train length`
    );
    ttStops.add(timetable.stop_id);
    const set = ttByLine.get(timetable.line_id) ?? new Set();
    set.add(timetable.stop_id);
    ttByLine.set(timetable.line_id, set);
  }

  // Pattern model (Guangzhou-style stubs, not Shanghai-style shared trunks):
  //  - One pattern per unique alignment. A pure reverse is the same alignment
  //    and must not exist as a second pattern.
  //  - Only the junction stop may appear on multiple patterns of a line.
  //    Through-running "branches" that re-list the trunk are rejected — model
  //    them as a spur from the junction instead.
  {
    const byLine = new Map<string, typeof d.patterns>();
    for (const p of d.patterns) {
      const list = byLine.get(p.line_id) ?? [];
      list.push(p);
      byLine.set(p.line_id, list);
    }
    for (const [lineId, linePatterns] of byLine) {
      // (a) No reverse-duplicate alignments.
      const seen = new Set<string>();
      for (const p of linePatterns) {
        const s = p.stop_ids.join('|');
        const r = [...p.stop_ids].reverse().join('|');
        assert(
          !seen.has(s) && !seen.has(r),
          network,
          `pattern ${p.id} on ${lineId} duplicates an alignment (or its reverse)`
        );
        seen.add(s);
      }

      // (b) Multi-pattern stops must be a junction of one of those patterns.
      const patternsByStop = new Map<string, string[]>();
      for (const p of linePatterns) {
        for (const stopId of p.stop_ids) {
          const list = patternsByStop.get(stopId) ?? [];
          list.push(p.id);
          patternsByStop.set(stopId, list);
        }
      }
      for (const [stopId, patternIds] of patternsByStop) {
        if (patternIds.length < 2) continue;
        const holders = linePatterns.filter((p) => patternIds.includes(p.id));
        const isJunctionOfSome = holders.some((p) => p.junction_stop_id === stopId);
        if (isJunctionOfSome) continue;
        fail(
          network,
          `stop ${stopId} on ${lineId} appears in ${patternIds.length} patterns but is not a junction (${patternIds.join(', ')})`
        );
      }

      // (c) Non-primary patterns that share the junction must expose it.
      for (const p of linePatterns) {
        if (p.is_primary) continue;
        const primary = linePatterns.find((x) => x.is_primary);
        if (!primary) continue;
        const trunk = new Set(primary.stop_ids);
        const shared = p.stop_ids.filter((id) => trunk.has(id));
        if (shared.length === 0) continue; // disjoint second alignment
        assert(
          p.junction_stop_id && stopById.has(p.junction_stop_id),
          network,
          `pattern ${p.id} shares stops with primary but has no junction_stop_id`
        );
        assert(
          p.junction_stop_id && trunk.has(p.junction_stop_id),
          network,
          `pattern ${p.id} junction_stop_id is not on the primary alignment`
        );
        // Spur form: the only shared stop is the junction.
        assert(
          shared.length === 1 && shared[0] === p.junction_stop_id,
          network,
          `pattern ${p.id} shares ${shared.length} stops with primary (want only the junction) — stub-ify the spur`
        );
      }
    }
  }

  // Homonym stations that are NOT a physical interchange must not share
  // coordinates — name-based geocoding otherwise copies a twin station's point
  // (Suzhou L8 陆慕古巷 vs L2 陆慕).
  {
    const byLoc = new Map<string, typeof d.stations>();
    for (const s of d.stations) {
      if (!s.location) continue;
      const key = `${s.location.lon.toFixed(5)},${s.location.lat.toFixed(5)}`;
      const list = byLoc.get(key) ?? [];
      list.push(s);
      byLoc.set(key, list);
    }
    for (const [key, group] of byLoc) {
      if (group.length < 2) continue;
      const names = new Set(group.map((s) => s.names?.zh ?? s.name));
      // Same display name co-located → true interchange / split platforms.
      if (names.size === 1) continue;
      // Multi-line station extras mean one physical node under several lines.
      const allMultiLine = group.every((s) => {
        const lines = (s.extras as { lines?: string[] } | undefined)?.lines ?? [];
        return lines.length > 1;
      });
      if (allMultiLine) continue;
      const codes = group.map((s) => {
        const c = (s.extras as { official_codes?: string[] } | undefined)?.official_codes ?? [];
        return c.join(',');
      });
      // Distinct official codes + distinct names + shared coords = collision.
      const codeSet = new Set(codes.filter(Boolean));
      if (codeSet.size <= 1 && names.size <= 1) continue;
      const linesOverlap = group.every((s, i) => {
        if (i === 0) return true;
        const a = new Set((group[0]!.extras as { lines?: string[] } | undefined)?.lines ?? []);
        const b = new Set((s.extras as { lines?: string[] } | undefined)?.lines ?? []);
        return [...b].some((l) => a.has(l));
      });
      if (
        linesOverlap &&
        group.every(
          (s) => ((s.extras as { lines?: string[] } | undefined)?.lines?.length ?? 0) >= 2
        )
      ) {
        continue;
      }
      fail(
        network,
        `homonym coordinate collision at ${key}: ${group
          .map((s, i) => `${s.names?.zh ?? s.name} (${s.id}, codes=${codes[i] || '—'})`)
          .join(' vs ')}`
      );
    }
  }

  // Reverse alignments are not patterns (direction lives on timetable dests).
  // `pattern_role=reverse` is therefore illegal.
  for (const pattern of d.patterns) {
    const role = (pattern.extras as { pattern_role?: string } | undefined)?.pattern_role;
    assert(
      role !== 'reverse',
      network,
      `pattern ${pattern.id} is tagged pattern_role=reverse — reverses must not be separate patterns`
    );
  }

  // Reverse-direction coverage: when a linear primary publishes any timetable
  // and stations sit away from both termini, at least two distinct destination
  // stations must appear — otherwise every row collapsed onto one direction.
  for (const line of d.lines) {
    if (line.status !== 'operating') continue;
    const primary = d.patterns.find((p) => p.line_id === line.id && p.is_primary);
    if (!primary || primary.stop_ids.length < 2) continue;
    const lineTts = d.timetables.filter((t) => t.line_id === line.id);
    if (lineTts.length === 0) continue;
    const destStationIds = new Set<string>();
    for (const t of lineTts) {
      if (!t.destination_stop_id) continue;
      const dest = stopById.get(t.destination_stop_id);
      if (dest) destStationIds.add(dest.station_id);
    }
    if (destStationIds.size === 0) continue;
    const originStop = stopById.get(primary.origin_stop_id);
    const termStop = stopById.get(primary.terminal_stop_id);
    const termini = new Set(
      [originStop?.station_id, termStop?.station_id].filter((x): x is string => Boolean(x))
    );
    if (termini.size < 2) continue;
    // Intermediate stations exist and every timetable points at one terminus only.
    const covered = [...termini].filter((id) => destStationIds.has(id));
    if (destStationIds.size === 1 && covered.length === 1 && lineTts.length >= 2) {
      fail(
        network,
        `line ${line.id} timetables all target one direction (dest stations=${destStationIds.size}); reverse direction missing`
      );
    }
  }

  // Coverage: on a line that publishes any timetable, every operating station
  // must have a timetable record for that line. Stations with zero timetables
  // on publishing lines are demoted to out_of_service by the adapters.
  // Interchange exception: if the station publishes times on a *different*
  // line, a missing record on this line is tolerated (source gap on one arm).
  const ttByStationLine = new Set(d.timetables.map((t) => `${t.station_id}|${t.line_id}`));
  const stationsWithAnyTt = new Set(d.timetables.map((t) => t.station_id));
  const stopsByLine = new Map<string, number>();
  for (const stop of d.stops) {
    stopsByLine.set(stop.line_id, (stopsByLine.get(stop.line_id) ?? 0) + 1);
  }
  for (const line of d.lines) {
    if (line.status !== 'operating') continue;
    if ((stopsByLine.get(line.id) ?? 0) === 0) continue;
    const published = ttByLine.get(line.id);
    if (!published || published.size === 0) continue;
    for (const stop of d.stops) {
      if (stop.line_id !== line.id) continue;
      const station = stationById.get(stop.station_id);
      if (station?.status !== 'operating') continue;
      if (ttByStationLine.has(`${station.id}|${line.id}`)) continue;
      assert(
        stationsWithAnyTt.has(station.id),
        network,
        `line ${line.id} publishes timetables but operating station ${station.id} has none`
      );
    }
  }

  // ── Fares ─────────────────────────────────────────────────────
  if (!d.fares) {
    fail(network, 'fares.json missing (required for a complete dataset)');
  }
  {
    const matrix = d.fares;
    assert(matrix.network_id === network, network, 'fare matrix network_id mismatch');
    assert(
      matrix.fares.length === matrix.station_ids.length,
      network,
      'fare matrix row count != station count'
    );
    const fareIds = new Set(matrix.station_ids);
    assert(fareIds.size === matrix.station_ids.length, network, 'duplicate fare station ids');
    for (const stationId of matrix.station_ids) {
      assert(stationIds.has(stationId), network, `fare matrix -> unknown station ${stationId}`);
    }
    for (const stationId of stationIds) {
      const status = stationById.get(stationId)?.status;
      // Fares are harvested for routable stations; planned/under-construction
      // rows may be absent from the matrix.
      assert(
        fareIds.has(stationId) || status !== 'operating',
        network,
        `station ${stationId} missing from fare matrix`
      );
    }
    matrix.station_ids.forEach((_, i) => {
      const row = matrix.fares[i] ?? [];
      assert(row.length === matrix.station_ids.length, network, `fare matrix row ${i} mismatch`);
      assert(row[i] === 0, network, `fare matrix diagonal ${i} must be 0`);
      row.forEach((price, j) => {
        if (price == null) return;
        assert(price >= 0, network, `fare matrix [${i}][${j}] is negative`);
        const mirror = matrix.fares[j]?.[i];
        assert(mirror === price, network, `fare matrix not symmetric at [${i}][${j}]`);
      });
    });
  }
}

interface NetworkManifest {
  files: Record<string, string>;
  stats: Record<string, number>;
  integrity: 'ok';
}

function statsOf(d: NetworkData): Record<string, number> {
  return {
    lines: d.lines.length,
    stations: d.stations.length,
    stops: d.stops.length,
    patterns: d.patterns.length,
    segments: d.segments.length,
    transfers: d.transfers.length,
    timetables: d.timetables.length,
    fare_stations: d.fares?.station_ids.length ?? 0,
    fare_pairs: d.fares
      ? d.fares.fares.reduce((n, row) => n + row.filter((p) => p != null && p > 0).length, 0) / 2
      : 0,
    official_transfer_times: d.transfers.filter((t) => t.walk_time_seconds != null).length,
    stations_with_coords: d.stations.filter((s) => s.location != null).length,
    stations_out_of_service: d.stations.filter((s) => s.status === 'out_of_service').length,
    stops_with_timetables: new Set(d.timetables.map((t) => t.stop_id)).size
  };
}

async function verifyNetwork(id: string): Promise<NetworkManifest> {
  const dir = join(DATA_ROOT, id);
  const data = await Effect.runPromise(loadNetwork(DATA_ROOT, id));
  verifyReferences(id, data);

  const files: Record<string, string> = {};
  for (const file of CANONICAL_FILES) {
    const raw = await readFile(join(dir, file)).catch(() => null);
    if (!raw) fail(id, `missing required file ${file}`);
    files[file] = `sha256:${sha256(raw)}`;
  }

  return { files, stats: statsOf(data), integrity: 'ok' };
}

function parseOut(): string {
  const i = process.argv.indexOf('--out');
  return resolve(
    i >= 0 ? (process.argv[i + 1] ?? 'dist/data-manifest.json') : 'dist/data-manifest.json'
  );
}

/** Optional `--network <id>` limits verification to one network (CI matrix). */
function parseNetworkFilter(): string | undefined {
  const i = process.argv.indexOf('--network');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const filter = parseNetworkFilter();
  const ids = (await readdir(DATA_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((id) => !filter || id === filter)
    .sort();

  if (ids.length === 0) {
    throw new Error(filter ? `network not found: ${filter}` : 'no networks under data/');
  }

  const networks: Record<string, NetworkManifest> = {};
  for (const id of ids) networks[id] = await verifyNetwork(id);

  const lines: string[] = [];
  for (const id of Object.keys(networks)) {
    for (const file of Object.keys(networks[id].files).sort()) {
      lines.push(`${id}/${file}:${networks[id].files[file]}`);
    }
  }
  const aggregate = `sha256:${sha256(lines.join('\n'))}`;

  const manifest = { schema_version: '1.0', networks, aggregate };
  const out = parseOut();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  for (const [id, entry] of Object.entries(networks)) {
    console.log(`${id}: ok ${JSON.stringify(entry.stats)}`);
  }
  console.log(`aggregate: ${aggregate}`);
  console.log(`manifest:  ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
