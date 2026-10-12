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
import { computeAndWriteFares, stageFareWorkbook } from './fares.js';
import { fetchFareWorkbook, fetchQingdaoSources } from './fetch.js';
import { QINGDAO_LINES } from './lines.js';
import { normalizeQingdao } from './normalize.js';
import {
  fixLinearRowDirection,
  type HarvestedStationTimes,
  linearTimesFromHarvest
} from './timetables.js';

export interface QingdaoNormalizeOptions {
  /** Repository root containing `data/cn-qingdao`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair in-vehicle distance harvest (dev runs). */
  skipDistances?: boolean;
}

/**
 * Fares-only pass against the freshly synced topology: download the official
 * workbook, validate samples against pjSearch, re-key onto `stations.json`
 * and rewrite `fares.json`. No planner harvest, no canonical rewrite.
 */
export async function runQingdaoFares(dataDir: string): Promise<void> {
  stageFareWorkbook(dataDir, await fetchFareWorkbook());
  await computeAndWriteFares(dataDir);
}

export async function runQingdaoNormalize(opts: QingdaoNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-qingdao');

  const sources = await fetchQingdaoSources();
  stageFareWorkbook(outDir, sources.fareWorkbook);

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Qingdao first/last trains are harvested via Baidu Direction Lite (the operator publishes timetables only as APP/WeChat images; no OCR).'
    );
  }

  const amapByLineName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );

  const harvestedRows = new Map<string, HarvestedStationTimes[]>();
  for (const cfg of QINGDAO_LINES) {
    const amap = amapByLineName.get(cfg.amapName);
    const names = (amap?.st ?? []).map((s) => String(s.n ?? '').trim()).filter((n) => n.length > 0);
    if (names.length < 2) continue;

    const coordsByFold = new Map<string, { lon: number; lat: number }>();
    for (const st of amap?.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coordsByFold.set(n, { lon, lat });
    }
    const refs: BaiduStationRef[] = names
      .map((name) => ({ name, ...(coordsByFold.get(name) ?? { lon: 0, lat: 0 }) }))
      .filter((r) => r.lon !== 0 && r.lat !== 0);
    if (refs.length < 2) {
      console.log(`    ${cfg.short}: skip Baidu (no coords)`);
      continue;
    }
    if (refs.length < names.length) {
      console.log(`    ${cfg.short}: ${names.length - refs.length} stations without coords`);
    }

    console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction Lite`);
    const harvested = await harvestBaiduTimetables(baiduAk, refs, { delayMs: 250, retries: 2 });
    const rows = linearTimesFromHarvest(names, harvested);
    const fixed = fixLinearRowDirection(rows);
    if (fixed.swapped) {
      console.log(`    ${cfg.short}: swapped mirrored planner directions`);
    }
    const withTimes = fixed.rows.filter(
      (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
    ).length;
    console.log(
      `    ${cfg.short}: baidu ${withTimes}/${fixed.rows.length} stations (${harvested.length} legs)`
    );
    harvestedRows.set(cfg.short, fixed.rows);
  }

  const canonical = normalizeQingdao(sources, harvestedRows);

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '青岛',
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

  const defaultTransfer = canonical.network.routing.default_transfer_seconds ?? 120;
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
          source_id: t.source_id ?? 'qdmetro-routing-default'
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
    // official-distances.json; haversine stays as the documented fallback.
    console.log('  harvest Baidu in-vehicle segment distances');
    await harvestAndApplySegmentDistances(outDir, baiduAk);
  }

  if (!opts.skipFares) {
    console.log('  write official fare matrix');
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
  runQingdaoNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipGeocode: process.argv.includes('--skip-geocode')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
