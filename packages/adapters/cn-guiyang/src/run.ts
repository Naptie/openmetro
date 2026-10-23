import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  normalizeTimetableTimes,
  type OfficialTransfer,
  type StationEncoded,
  writeCanonical
} from '@openmetro/core';
import { buildFareMatrix, type FareStation } from './fares.js';
import { fetchGuiyangSources, type GuiyangSources } from './fetch.js';
import { guiyangStationName } from './names.js';
import { normalizeGuiyang } from './normalize.js';
import { harvestSegmentMetrics, type SegmentHarvestPair } from './segments.js';
import { harvestStationTimetables, type TimetableHarvestLine } from './timetables.js';
import { harvestInterchangeWalks, type InterchangeCandidate } from './transfers.js';

export interface GuiyangNormalizeOptions {
  /** Repository root containing `data/cn-guiyang`. */
  root?: string;
  /** Skip the geocoding cascade (the AMap dataset already covers every stop). */
  skipGeocode?: boolean;
  /** Skip the planner first/last harvest. */
  skipTimetables?: boolean;
  /** Skip the planner per-segment harvest. */
  skipSegmentMetrics?: boolean;
  /** Skip the planner interchange-walk harvest. */
  skipInterchanges?: boolean;
  /** Also harvest the OD fare matrix. */
  includeFares?: boolean;
}

/** Delay between planner queries. The endpoint is a small production service. */
const PLANNER_DELAY_MS = 120;

/** One line's stops in the operator's published order. */
interface LinePlan {
  officialId: string;
  stations: { name: string; coord: string }[];
}

/**
 * Group the operator's station list into lines, preserving the published
 * order within each line.
 */
function planLines(sources: GuiyangSources): LinePlan[] {
  const byLine = new Map<string, LinePlan>();
  for (const stop of sources.officialStops) {
    const plan = byLine.get(stop.lineId) ?? { officialId: stop.lineId, stations: [] };
    plan.stations.push({ name: guiyangStationName(stop.name), coord: stop.coord });
    byLine.set(stop.lineId, plan);
  }
  return [...byLine.values()];
}

/** Adjacent stop pairs of every line — one planner query each. */
function adjacentPairs(lines: LinePlan[]): SegmentHarvestPair[] {
  const out: SegmentHarvestPair[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.stations.length; i++) {
      const a = line.stations[i]!;
      const b = line.stations[i + 1]!;
      out.push({
        fromName: a.name,
        toName: b.name,
        fromCoord: a.coord,
        toCoord: b.coord,
        lineId: line.officialId
      });
    }
  }
  return out;
}

/**
 * Candidate queries that make the planner change lines at an interchange.
 *
 * The traveller has to start on the arrival line *before* the interchange and
 * finish on the departure line *after* it, so the only sensible route is
 * ride → walk → ride. Each ordered line pair yields one candidate.
 */
function interchangeCandidates(lines: LinePlan[]): InterchangeCandidate[] {
  const lineById = new Map(lines.map((l) => [l.officialId, l] as const));

  // Station name → the lines it appears on.
  const linesByStation = new Map<string, string[]>();
  for (const line of lines) {
    for (const s of line.stations) {
      const list = linesByStation.get(s.name) ?? [];
      if (!list.includes(line.officialId)) list.push(line.officialId);
      linesByStation.set(s.name, list);
    }
  }

  const out: InterchangeCandidate[] = [];
  for (const [stationName, lineIds] of linesByStation) {
    if (lineIds.length < 2) continue;
    for (const fromLineId of lineIds) {
      for (const toLineId of lineIds) {
        if (fromLineId === toLineId) continue;
        const fromLine = lineById.get(fromLineId);
        const toLine = lineById.get(toLineId);
        if (!fromLine || !toLine) continue;

        const fromIdx = fromLine.stations.findIndex((s) => s.name === stationName);
        const toIdx = toLine.stations.findIndex((s) => s.name === stationName);
        if (fromIdx < 0 || toIdx < 0) continue;

        // Origin: the neighbour of the interchange on the arrival line.
        const origin =
          fromLine.stations[fromIdx - 1] ?? fromLine.stations[fromIdx + 1] ?? undefined;
        // Destination: the neighbour of the interchange on the departure line.
        const destination = toLine.stations[toIdx + 1] ?? toLine.stations[toIdx - 1] ?? undefined;
        if (
          !origin ||
          !destination ||
          origin.name === stationName ||
          destination.name === stationName
        )
          continue;

        out.push({
          stationName,
          fromLineId,
          toLineId,
          fromCoord: origin.coord,
          fromName: origin.name,
          toCoord: destination.coord,
          toName: destination.name
        });
      }
    }
  }
  return out;
}

/**
 * English labels that carry no information — the Wikidata fallback answer.
 */
const GENERIC_EN = /^(station|metro station|subway station|车站|地铁站)$/i;

function sanitizeEnglishNames(
  original: StationEncoded[],
  filled: StationEncoded[]
): StationEncoded[] {
  const byId = new Map(original.map((s) => [s.id, s] as const));
  return filled.map((s) => {
    if (!GENERIC_EN.test(s.names.en.trim())) return s;
    const prior = byId.get(s.id);
    if (prior?.names.en.trim()) return prior;
    return { ...s, names: { ...s.names, en: '' } };
  });
}

/** Recompute `network.quality` from the final canonical files on disk. */
async function refreshQuality(dataDir: string): Promise<void> {
  const { computeNetworkQuality } = await import('@openmetro/core');
  const read = async (name: string) => JSON.parse(await readFile(join(dataDir, name), 'utf-8'));
  const readOptional = async (name: string) => {
    try {
      return await read(name);
    } catch {
      return undefined;
    }
  };
  const network = await read('network.json');
  const quality = computeNetworkQuality({
    lines: (await read('lines.json')).records,
    stations: (await read('stations.json')).records,
    stops: (await read('stops.json')).records,
    segments: (await read('segments.json')).records,
    transfers: (await read('transfers.json')).records,
    timetables: (await read('timetables.json')).records,
    fares: await readOptional('fares.json')
  });
  await writeFile(
    join(dataDir, 'network.json'),
    `${JSON.stringify({ ...network, quality }, null, 2)}\n`,
    'utf-8'
  );
  console.log('  refreshed network.quality');
}

export async function runGuiyangNormalize(opts: GuiyangNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-guiyang');

  const sources = await fetchGuiyangSources();
  const lines = planLines(sources);

  // ---- Per-segment ride times / distances (official planner) -----------------
  const pairs = adjacentPairs(lines);
  let segmentMetrics: Awaited<ReturnType<typeof harvestSegmentMetrics>>['segments'] = [];
  if (!opts.skipSegmentMetrics) {
    console.log(`  harvest ${pairs.length} adjacent-pair segment metrics via the official planner`);
    const res = await harvestSegmentMetrics(pairs, { delayMs: PLANNER_DELAY_MS });
    segmentMetrics = res.segments;
    console.log(
      `    segment metrics: ${segmentMetrics.length}/${pairs.length} measured` +
        (res.gaps.length ? `, ${res.gaps.length} gap(s)` : '')
    );
    for (const g of res.gaps.slice(0, 10)) console.log(`      gap: ${g}`);
  }

  // ---- Interchange walk distances (official planner) -------------------------
  const candidates = interchangeCandidates(lines);
  let interchanges: Awaited<ReturnType<typeof harvestInterchangeWalks>>['interchanges'] = [];
  if (!opts.skipInterchanges) {
    console.log(`  harvest ${candidates.length} interchange walks via the official planner`);
    const res = await harvestInterchangeWalks(candidates, { delayMs: PLANNER_DELAY_MS });
    interchanges = res.interchanges;
    console.log(
      `    interchange walks: ${interchanges.length}/${candidates.length} measured` +
        (res.gaps.length ? `, ${res.gaps.length} gap(s)` : '')
    );
    for (const g of res.gaps.slice(0, 10)) console.log(`      gap: ${g}`);
  }

  // ---- Per-station, per-direction first/last trains --------------------------
  let timetableRows: Awaited<ReturnType<typeof harvestStationTimetables>>['rows'] = [];
  if (!opts.skipTimetables) {
    const harvestLines: TimetableHarvestLine[] = lines.map((l) => ({
      lineId: l.officialId,
      stations: l.stations
    }));
    const expected = harvestLines.reduce((n, l) => n + (l.stations.length - 1) * 2, 0);
    console.log(
      `  harvest first/last trains for ${harvestLines.reduce((n, l) => n + l.stations.length, 0)} stations via the official planner`
    );
    const res = await harvestStationTimetables(harvestLines, { delayMs: PLANNER_DELAY_MS });
    timetableRows = res.rows;
    console.log(
      `    first/last entries: ${timetableRows.length} (expected ${expected})` +
        (res.gaps.length ? `, ${res.gaps.length} gap(s)` : '')
    );
    for (const g of res.gaps.slice(0, 10)) console.log(`      gap: ${g}`);
  }

  const canonical = normalizeGuiyang({
    sources,
    harvestedTimetables: timetableRows,
    harvestedSegments: segmentMetrics,
    harvestedInterchanges: interchanges
  });

  // ---- English names --------------------------------------------------------
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations = sanitizeEnglishNames(canonical.stations, enFill.stations);
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  // ---- Coordinates ----------------------------------------------------------
  // The AMap Subway dataset already carries a GCJ-02 coordinate for every
  // stop, so the geocoding cascade only has to validate them; the operator's
  // own coordinates are a different (local survey) datum and are therefore
  // deliberately **not** handed to the cascade.
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '贵阳',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    for (let i = 0; i < located.length; i++) stations[i] = located[i]!;
  }

  // ---- Transfers ------------------------------------------------------------
  // The operator publishes the interchange **distance**; the walk *time* is
  // measured by the core gapfill layer (the operator rounds it to whole
  // minutes, which is useless), so it is deliberately left unset here.
  const stationIdByName = new Map(stations.map((s) => [s.name, s.id] as const));
  const lineIdByOfficialId = new Map(
    canonical.lines.map((l) => [String(l.extras?.official_line_id ?? ''), l.id] as const)
  );
  const officialTransfers: OfficialTransfer[] = [];
  for (const x of interchanges) {
    const stationId = stationIdByName.get(x.stationName);
    const fromLineId = lineIdByOfficialId.get(x.fromLineId);
    const toLineId = lineIdByOfficialId.get(x.toLineId);
    if (!stationId || !fromLineId || !toLineId) continue;
    officialTransfers.push({
      station_id: stationId,
      from_line_id: fromLineId,
      to_line_id: toLineId,
      source_id: 'gyurt-planner-interchange'
    });
  }
  const transfers = deriveTransfers(stations, canonical.stops, officialTransfers, {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  // Publish the operator's walk distance on the matching transfer edges.
  //
  // The operator publishes the **in-station** walk (the concourse walk between
  // two platforms, e.g. `站厅换乘 步行72米`); the core gapfill layer measures a
  // street-level walk between two station entrances and writes it into
  // `walk_distance_meters`. The two measure different things, so the operator's
  // figure is kept under its own name instead of being overwritten.
  const walkDistanceByKey = new Map(
    interchanges.map((x) => {
      const stationId = stationIdByName.get(x.stationName) ?? '';
      const fromLineId = lineIdByOfficialId.get(x.fromLineId) ?? '';
      const toLineId = lineIdByOfficialId.get(x.toLineId) ?? '';
      return [`${stationId}|${fromLineId}|${toLineId}`, x] as const;
    })
  );
  let walkDistancesApplied = 0;
  const transfersWithDistance = transfers.map((t) => {
    const hit = walkDistanceByKey.get(`${t.station_id}|${t.from_line_id}|${t.to_line_id}`);
    if (!hit) return t;
    walkDistancesApplied++;
    return {
      ...t,
      extras: {
        ...(t.extras ?? {}),
        official_walk_distance_meters: hit.walkDistanceMeters,
        official_walk_instruction: hit.instructions,
        walk_distance_source: 'gyurt-planner'
      }
    };
  });
  transfers.length = 0;
  transfers.push(...transfersWithDistance);
  console.log(
    `  transfers: ${transfers.length} edges, ${walkDistancesApplied} with the operator's walk distance`
  );

  // ---- Segment times --------------------------------------------------------
  // The operator publishes every adjacent pair's own run time and distance, so
  // the derived fallbacks below only fill the rare gap.
  let segments = canonical.segments;
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  // ---- Fares ----------------------------------------------------------------
  let fares: Awaited<ReturnType<typeof buildFareMatrix>>['matrix'] | undefined;
  if (opts.includeFares) {
    const fareStations: FareStation[] = stations.map((s) => {
      const coord = canonical.officialCoords.get(s.id);
      if (!coord) throw new Error(`no operator coordinate for station ${s.name}`);
      return { id: s.id, name: s.name, coord };
    });
    const res = await buildFareMatrix(fareStations, {
      delayMs: 60,
      onProgress: (done, total) => {
        if (done % 500 === 0) console.log(`    fares ${done}/${total}`);
      }
    });
    fares = res.matrix;
    console.log(
      `  fares: ${res.matrix.fares.flat().filter((f) => f != null).length - stations.length} quoted cells, ` +
        `${res.unquoted.length} unquoted, ${res.asymmetric.length} asymmetric, ${res.rejected.length} rejected`
    );
    for (const u of res.unquoted.slice(0, 10)) console.log(`      unquoted: ${u}`);
    for (const a of res.asymmetric.slice(0, 10)) console.log(`      asymmetric: ${a}`);
  }

  console.log(`  geocode: subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`);
  console.log(
    `  counts: lines=${canonical.lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines: canonical.lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables,
    fares
  });
  console.log(`  wrote ${outDir}`);

  if (fares) await refreshQuality(outDir);

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('with English names:', stations.filter((s) => s.names.en.trim()).length);
  console.log('stops:', canonical.stops.length);
  console.log('patterns:', canonical.patterns.length);
  console.log('segments:', segments.length);
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('segments by time source:', bySrc);
  console.log('transfers:', transfers.length);
  console.log(
    'transfers with walk time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log(
    'transfers with walk distance:',
    transfers.filter((t) => t.walk_distance_meters != null).length
  );
  console.log('timetables:', timetables.length);
}

/**
 * Rebuild only the OD fare matrix from the canonical station table.
 *
 * Used by the fares-only sync path: the station ids and names come from
 * `stations.json`, the operator's coordinate strings are re-fetched from the
 * official station list.
 */
export async function runGuiyangFaresOnly(dataDir: string): Promise<void> {
  const sources = await fetchGuiyangSources();
  const coordByName = new Map<string, string>();
  for (const stop of sources.officialStops) {
    coordByName.set(guiyangStationName(stop.name), stop.coord);
  }

  const stationsDoc = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')) as {
    records: { id: string; name: string }[];
  };
  const fareStations: FareStation[] = [];
  const missing: string[] = [];
  for (const s of stationsDoc.records) {
    const coord = coordByName.get(s.name);
    if (!coord) {
      missing.push(s.name);
      continue;
    }
    fareStations.push({ id: s.id, name: s.name, coord });
  }
  if (missing.length) {
    throw new Error(
      `no operator coordinate for ${missing.length} station(s): ${missing.slice(0, 10).join(', ')}`
    );
  }

  const res = await buildFareMatrix(fareStations, {
    delayMs: 60,
    onProgress: (done, total) => {
      if (done % 500 === 0) console.log(`    fares ${done}/${total}`);
    }
  });
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(res.matrix, null, 2)}\n`, 'utf-8');
  console.log(
    `  fares: ${res.matrix.fares.flat().filter((f) => f != null).length - fareStations.length} quoted cells, ` +
      `${res.unquoted.length} unquoted, ${res.asymmetric.length} asymmetric, ${res.rejected.length} rejected`
  );
  for (const u of res.unquoted.slice(0, 10)) console.log(`    unquoted: ${u}`);
  for (const a of res.asymmetric.slice(0, 10)) console.log(`    asymmetric: ${a}`);
  await refreshQuality(dataDir);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runGuiyangNormalize({
    skipTimetables: process.argv.includes('--skip-timetables'),
    skipSegmentMetrics: process.argv.includes('--skip-segments'),
    skipInterchanges: process.argv.includes('--skip-interchanges'),
    includeFares: process.argv.includes('--fares')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
