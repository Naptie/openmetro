import { join } from 'node:path';
import {
  applyDerivedTimes,
  type BaiduLegTimes,
  type BaiduStationRef,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fetchBaiduSubwayLeg,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  harvestBaiduTimetables,
  lastDepartureFromArrival,
  loadBaiduAk,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';
import { fareSpec } from './fares.js';
import { fetchXiamenSources } from './fetch.js';
import { XIAMEN_LINES } from './lines.js';
import { normalizeXiamen } from './normalize.js';
import {
  baiduTimesFromHarvest,
  type DirectedTimes,
  fixMirroredTimes,
  mapCmsDirectedTimes,
  mergeDirectedTimes,
  planBaiduGapQueries
} from './timetables.js';

export interface XiamenNormalizeOptions {
  /** Repository root containing `data/cn-xiamen`. */
  root?: string;
  /** Skip coordinate enrichment (offline / partial rebuilds). */
  skipGeocode?: boolean;
  /** Skip the live OD fare harvest. */
  skipFares?: boolean;
}

export async function runXiamenNormalize(opts: XiamenNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-xiamen');

  const sources = await fetchXiamenSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Xiamen lines 4/6 publish no timetable records, ' +
        'so first/last trains are harvested via Baidu Direction Lite.'
    );
  }

  // AMap station order is the topology spine; every harvest keys off it.
  const amapByName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );
  const stationsByLine = new Map<string, string[]>();
  const refsByLine = new Map<string, BaiduStationRef[]>();
  for (const cfg of XIAMEN_LINES) {
    const amap = amapByName.get(cfg.amapName);
    const names = (amap?.st ?? []).map((s) => String(s.n ?? '').trim()).filter((n) => n.length > 0);
    if (names.length < 2) continue;
    stationsByLine.set(cfg.amapName, names);
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
    refsByLine.set(cfg.amapName, refs);
  }

  // CMS first/last trains (lines 1–3).
  const cms = mapCmsDirectedTimes(sources, stationsByLine);
  for (const issue of cms.issues) console.log(`    ${issue}`);

  // Planner harvest: wholesale for lines 4/6 (no CMS records), one targeted
  // query per missing direction for CMS-covered lines.
  const mergedTimesByLine = new Map<string, DirectedTimes[]>();
  for (const cfg of XIAMEN_LINES) {
    const cmsTimes = cms.timesByCmsLine.get(cfg.cmsLineId) ?? [];
    if (!cfg.cmsTimetable) {
      const refs = refsByLine.get(cfg.amapName) ?? [];
      if (refs.length < 2) {
        console.log(`    ${cfg.short}: skip Baidu harvest (no coords)`);
        mergedTimesByLine.set(cfg.short, cmsTimes);
        continue;
      }
      console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction Lite`);
      const harvested = await harvestBaiduTimetables(baiduAk, refs, { delayMs: 250, retries: 2 });
      const baiduTimes = baiduTimesFromHarvest(harvested);
      const fixed = fixMirroredTimes(stationsByLine.get(cfg.amapName) ?? [], baiduTimes);
      if (fixed.swapped) {
        console.log(`    ${cfg.short}: swapped mirrored planner directions`);
      }
      const withTimes = fixed.times.filter((t) => t.first || t.last).length;
      console.log(`    ${cfg.short}: baidu ${withTimes} directed times (${harvested.length} legs)`);
      mergedTimesByLine.set(cfg.short, mergeDirectedTimes(cmsTimes, fixed.times));
      continue;
    }

    const refsByFold = new Map<string, BaiduStationRef>();
    for (const ref of refsByLine.get(cfg.amapName) ?? []) {
      if (!refsByFold.has(ref.name)) refsByFold.set(ref.name, ref);
    }
    const gaps = planBaiduGapQueries(cmsTimes, stationsByLine.get(cfg.amapName) ?? [], cfg);
    const fill: DirectedTimes[] = [];
    for (const gap of gaps) {
      const from = refsByFold.get(gap.stationName);
      const to = refsByFold.get(gap.destName);
      if (!from || !to) continue;
      const leg: BaiduLegTimes | null = await fetchBaiduSubwayLeg(baiduAk, from, to).catch(
        () => null
      );
      await new Promise((r) => setTimeout(r, 250));
      if (!leg?.firstDeparture && !leg?.lastArrival) continue;
      fill.push({
        stationName: gap.stationName,
        destName: gap.destName,
        direction: gap.direction,
        first: leg.firstDeparture ?? null,
        last: lastDepartureFromArrival(
          leg.lastArrival ?? null,
          leg.firstDeparture ?? null,
          leg.durationSeconds ?? null
        ),
        source: 'baidu-directionlite-transit'
      });
    }
    if (gaps.length > 0) {
      console.log(`    ${cfg.short}: ${fill.length}/${gaps.length} CMS gaps filled via Baidu`);
    }
    mergedTimesByLine.set(cfg.short, mergeDirectedTimes(cmsTimes, fill));
  }

  const canonical = normalizeXiamen(sources, mergedTimesByLine);

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stationsWithEn = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = stationsWithEn;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(stationsWithEn, {
      city: '厦门',
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
          source_id: t.source_id ?? 'xmgdjt-routing-default'
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

  if (!opts.skipFares) {
    console.log('  harvest official OD fares');
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 12, delay: 60 });
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
  const ttBySrc: Record<string, number> = {};
  for (const t of timetables) {
    const k = t.source_id ?? 'none';
    ttBySrc[k] = (ttBySrc[k] ?? 0) + 1;
  }
  console.log('timetables by source:', ttBySrc);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runXiamenNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipGeocode: process.argv.includes('--skip-geocode')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
