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
  writeCanonical
} from '@openmetro/core';

import { computeAndWriteFares } from './fares.js';
import { fetchAmapSubway } from './fetch.js';
import { KUNMING_LINES } from './lines.js';
import { buildKunmingTopology, buildThroughRunTransfers, normalizeKunming } from './normalize.js';
import { harvestKunmingPlanner, type LinePatternHarvest } from './times.js';

export interface KunmingNormalizeOptions {
  /** Repository root containing `data/cn-kunming`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip the fare matrix computation. */
  skipFares?: boolean;
  /** Skip the planner harvest (topology only — dev runs). */
  skipHarvest?: boolean;
  /** Planner requests in flight at once. */
  concurrency?: number;
}

/**
 * Regenerate the canonical dataset for Kunming Rail Transit.
 *
 * The operator's own site is gone (see `lines.ts`), so everything comes from
 * the AMap subway dataset plus the AMap metro planner.
 */
export async function runKunmingNormalize(opts: KunmingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-kunming');

  console.log('  fetch AMap subway dataset 5301');
  const amap = await fetchAmapSubway();

  console.log('  build topology');
  const topology = buildKunmingTopology(amap);
  console.log(
    `    lines=${topology.lines.length} stations=${topology.stations.length} stops=${topology.stops.length} ` +
      `patterns=${topology.patterns.length} segments=${topology.segments.length}`
  );

  let harvest: LinePatternHarvest[] = [];
  if (!opts.skipHarvest) {
    console.log('  harvest AMap metro planner (segment metrics + first/last trains)');
    harvest = await harvestKunmingPlanner(
      KUNMING_LINES.map((cfg) => ({
        short: cfg.short,
        plannerName: cfg.plannerName,
        alignments: (topology.alignmentsByLine.get(cfg.short) ?? []).map((a) => ({
          role: a.role,
          amapNames: a.amapNames,
          stations: a.plannerStations,
          stopIds: a.stopIds
        }))
      })),
      {
        concurrency: opts.concurrency ?? 6,
        delayMs: 60,
        onProgress: (msg) => console.log(msg)
      }
    );
  }

  const canonical = normalizeKunming(topology, harvest);

  const enFill = await fillStationEnglishNames(canonical.stations);
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);
  let stations = enFill.stations;

  if (!opts.skipGeocode) {
    let officialMatched = 0;
    let subwayMatched = 0;
    let overpassMatched = 0;
    let geocoded = 0;
    stations = await fillCoordinates(canonical.stations, {
      city: '昆明',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onOfficialMatch: () => officialMatched++,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    console.log(
      `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
    );
  }

  // Lines 1 and 2 are through-connected at 环城南路: a train continues from
  // one line to the other, so the shared station has a zero-second transfer.
  const officialTransfers = buildThroughRunTransfers(canonical);

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
  const transfers = deriveTransfers(stations, canonical.stops, officialTransfers, {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'km-routing-default'
        }
  );

  let segments = canonical.segments;
  // The last-train chain is a free by-product of the planner harvest; the
  // core gapfill layer upgrades anything the planner could not answer.
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
    timetables
  });
  console.log(`  wrote ${outDir}`);

  if (!opts.skipFares) {
    console.log('  compute fares from the official distance ladder');
    await computeAndWriteFares(outDir);
  }

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('stops:', canonical.stops.length);
  console.log('patterns:', canonical.patterns.length);
  console.log('segments:', segments.length);
  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('segments by time source:', bySrc);
  const byDistance: Record<string, number> = {};
  for (const s of segments) {
    const extras = (s.extras ?? {}) as Record<string, unknown>;
    const k = typeof extras.distance_source === 'string' ? extras.distance_source : 'none';
    byDistance[k] = (byDistance[k] ?? 0) + 1;
  }
  console.log('segments by distance source:', byDistance);
  console.log('transfers:', transfers.length);
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runKunmingNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipHarvest: process.argv.includes('--skip-harvest'),
    skipGeocode: process.argv.includes('--skip-geocode')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
