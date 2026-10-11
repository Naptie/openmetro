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
  type OfficialTransfer,
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares, harvestAndApplySegmentDistances } from './fares.js';
import { fetchJinanSources } from './fetch.js';
import { JINAN_LINES } from './lines.js';
import { type JinanCanonical, normalizeJinan, STATION_COORD_OVERRIDES } from './normalize.js';
import {
  type HarvestedStationTimes,
  harvestLoopTimetables,
  linearTimesFromHarvest
} from './timetables.js';

export interface JinanNormalizeOptions {
  /** Repository root containing `data/cn-jinan`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair in-vehicle distance harvest (dev runs). */
  skipDistances?: boolean;
}

/** 4/8 号线共线贯通：换乘发生在共线段东端枢纽。 */
const THROUGH_RUN_SOURCE = 'jngd-through-run-4-8';

export async function runJinanNormalize(opts: JinanNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-jinan');

  const sources = await fetchJinanSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Jinan first/last trains are harvested via Baidu Direction Lite (the operator publishes its timetable only as JPEG images; no OCR).'
    );
  }

  const amapByLineName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );

  const harvestedRows = new Map<string, HarvestedStationTimes[]>();
  for (const cfg of JINAN_LINES) {
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
    const missing = names.length - refs.length;
    if (refs.length < 2) {
      console.log(`    ${cfg.short}: skip Baidu (no coords)`);
      continue;
    }
    if (missing > 0) {
      console.log(`    ${cfg.short}: ${missing} stations without coords`);
    }

    if (cfg.loop) {
      console.log(`    ${cfg.short}: harvesting ring directions via Baidu Direction Lite`);
      harvestedRows.set(cfg.short, await harvestLoopTimetables(baiduAk, refs));
      continue;
    }

    console.log(`    ${cfg.short}: harvesting first/last via Baidu Direction Lite`);
    const harvested = await harvestBaiduTimetables(baiduAk, refs, { delayMs: 250, retries: 2 });
    const rows = linearTimesFromHarvest(names, harvested);
    const withTimes = rows.filter((r) => r.downFirst || r.downLast || r.upFirst || r.upLast).length;
    console.log(
      `    ${cfg.short}: baidu ${withTimes}/${rows.length} stations (${harvested.length} legs)`
    );
    harvestedRows.set(cfg.short, rows);
  }

  const canonical = normalizeJinan(sources, harvestedRows);

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
      city: '济南',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      // Hand-verified against the official network map: AMap swaps the two
      // Line 6 terminus coordinates. KnownLocations outrank every geocoder.
      knownLocations: Object.entries(STATION_COORD_OVERRIDES).map(([name, loc]) => ({
        name,
        location: { ...loc, crs: 'gcj02' as const },
        source: 'official-map'
      })),
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

  // 4/8 共线贯通：same physical station, trains continue without a transfer.
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
          source_id: t.source_id ?? 'jngd-routing-default'
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
    console.log('  harvest Baidu in-vehicle segment distances');
    await harvestAndApplySegmentDistances(outDir, baiduAk);
  }

  if (!opts.skipFares) {
    console.log('  compute tariff fares from official mileage policy');
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

/** 0-second transfer edges for the joint 4/8 through service at the junction. */
function buildThroughRunTransfers(canonical: JinanCanonical): OfficialTransfer[] {
  const out: OfficialTransfer[] = [];
  const pairs = JINAN_LINES.filter((l) => l.throughRunWith).map((l) => ({
    short: l.short,
    partner: l.throughRunWith!
  }));
  for (const { short, partner } of pairs) {
    const partnerShort = partner.split('/').find((s) => s !== short);
    if (!partnerShort) continue;
    const lineA = canonical.lines.find((l) => l.short_name === short);
    const lineB = canonical.lines.find((l) => l.short_name === partnerShort);
    if (!lineA || !lineB) continue;
    const stopsA = canonical.stops.filter((s) => s.line_id === lineA.id);
    const stopsB = canonical.stops.filter((s) => s.line_id === lineB.id);
    const stationsA = new Set(stopsA.map((s) => s.station_id));
    for (const stopB of stopsB) {
      if (!stationsA.has(stopB.station_id)) continue;
      out.push(
        {
          station_id: stopB.station_id,
          from_line_id: lineA.id,
          to_line_id: lineB.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: THROUGH_RUN_SOURCE
        },
        {
          station_id: stopB.station_id,
          from_line_id: lineB.id,
          to_line_id: lineA.id,
          walk_time_seconds: 0,
          is_out_of_station: false,
          source_id: THROUGH_RUN_SOURCE
        }
      );
    }
  }
  return out;
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runJinanNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipDistances: process.argv.includes('--skip-distances')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
