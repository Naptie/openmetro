import { join } from 'node:path';
import {
  applyDerivedTimes,
  type BaiduStationRef,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  harvestBaiduTimetables,
  loadBaiduAk,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { harvestAndApplySegmentDistances } from './distances.js';
import { computeAndWriteFares } from './fares.js';
import { fetchDalianSources } from './fetch.js';
import { dalianAlignments, normalizeDalian } from './normalize.js';
import { fixLinearRowDirection, linearTimesFromHarvest } from './timetables.js';

export interface DalianNormalizeOptions {
  /** Repository root containing `data/cn-dalian`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair in-vehicle distance harvest (dev runs). */
  skipDistances?: boolean;
}

/**
 * Fares-only pass against the freshly synced topology: recompute the official
 * distance ladder on top of the segment distances already on disk. No planner
 * harvest, no canonical rewrite.
 */
export async function runDalianFares(dataDir: string): Promise<void> {
  await computeAndWriteFares(dataDir);
}

export async function runDalianNormalize(opts: DalianNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-dalian');

  const sources = await fetchDalianSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Dalian first/last trains are harvested via Baidu Direction Lite (the operator publishes timetables only as APP/WeChat images; no OCR).'
    );
  }

  // ---- first/last trains, per alignment --------------------------------
  const alignments = dalianAlignments(sources);
  const harvestedRows = new Map<string, ReturnType<typeof linearTimesFromHarvest>>();
  for (const al of alignments) {
    const refs: BaiduStationRef[] = al.stations;
    console.log(
      `    ${al.lineName}${al.ttKey === al.short ? '' : ` (${al.ttKey})`}: harvesting first/last via Baidu Direction Lite`
    );
    const harvested = await harvestBaiduTimetables(baiduAk, refs, { delayMs: 250, retries: 2 });
    const rows = linearTimesFromHarvest(
      al.stations.map((s) => s.name),
      harvested
    );
    const fixed = fixLinearRowDirection(rows);
    if (fixed.swapped) {
      console.log(`    ${al.lineName}: swapped mirrored planner directions`);
    }
    const withTimes = fixed.rows.filter(
      (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
    ).length;
    console.log(
      `    ${al.lineName}: baidu ${withTimes}/${fixed.rows.length} stations (${harvested.length} legs)`
    );
    harvestedRows.set(al.patternId, fixed.rows);
  }

  const canonical = normalizeDalian(sources, harvestedRows);

  const enFill = await fillStationEnglishNames(canonical.stations);
  let stations = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '大连',
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
  }

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 180;
  const transfers = deriveTransfers(stations, canonical.stops, [], {
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
          source_id: t.source_id ?? 'dlmetro-routing-default'
        }
  );

  let segments = canonical.segments;
  // last_train diffs are a free by-product of the first/last harvest; the
  // Baidu gapfill layer (`data:sync --layer gapfill`) upgrades from there.
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
    `  geocode: official=${officialMatched} subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`
  );
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

  if (!opts.skipDistances) {
    // In-vehicle segment km from the Baidu Direction planner, cached in
    // official-distances.json. The fare ladder reads these, so this must run
    // before the fare pass.
    console.log('  harvest Baidu in-vehicle segment distances');
    await harvestAndApplySegmentDistances(outDir, baiduAk);
  }

  if (!opts.skipFares) {
    console.log('  write official distance-ladder fare matrix');
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
  console.log('transfers:', transfers.length);
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runDalianNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipGeocode: process.argv.includes('--skip-geocode'),
    skipDistances: process.argv.includes('--skip-distances')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
