import { join } from 'node:path';
import {
  applyDerivedTimes,
  applyHarvestedSegmentTimes,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  loadBaiduAk,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { fetchHarbinSources } from './fetch.js';
import { HARBIN_LINES } from './lines.js';
import { normalizeHarbin, orderedStationNames } from './normalize.js';
import { harvestHarbinLine, type SegmentMetric, type StationRef } from './timetables.js';

export interface HarbinNormalizeOptions {
  /** Repository root containing `data/cn-harbin`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip the Baidu adjacent-pair harvest (dev runs). */
  skipHarvest?: boolean;
}

export async function runHarbinNormalize(opts: HarbinNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-harbin');

  const sources = await fetchHarbinSources();

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Harbin first/last trains and segment metrics are harvested via Baidu Direction v2 (the operator publishes timetable and fares only as prose and images; no OCR).'
    );
  }

  const amapByLineName = new Map(
    (sources.amapSubway.l ?? [])
      .map((l) => [String(l.ln ?? '').trim(), l] as const)
      .filter(([ln]) => ln.length > 0)
  );

  // First/last trains + in-vehicle segment metrics, per line.
  const harvestedRows = new Map<string, Awaited<ReturnType<typeof harvestHarbinLine>>['rows']>();
  const metrics = new Map<string, SegmentMetric>();
  for (const cfg of HARBIN_LINES) {
    const amap = amapByLineName.get(cfg.amapName);
    const names = orderedStationNames(amap ?? {});
    if (names.length < 2) continue;

    const coordByName = new Map<string, { lon: number; lat: number }>();
    for (const st of amap?.st ?? []) {
      const n = String(st.n ?? '').trim();
      const sl = String(st.sl ?? '');
      if (!n || !sl || coordByName.has(n)) continue;
      const [lonRaw, latRaw] = sl.split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coordByName.set(n, { lon, lat });
    }
    const refs: StationRef[] = names
      .map((name) => {
        const c = coordByName.get(name);
        return c ? { name, lon: c.lon, lat: c.lat } : null;
      })
      .filter((r): r is StationRef => r !== null);
    if (refs.length < 2) {
      console.log(`    ${cfg.short}: skip Baidu harvest (no coords)`);
      continue;
    }

    if (opts.skipHarvest) {
      console.log(`    ${cfg.short}: skip Baidu harvest (--skip-harvest)`);
      continue;
    }

    console.log(
      `    ${cfg.short}: harvesting first/last + segment metrics via Baidu Direction v2 (${refs.length} stops)`
    );
    const harvest = await harvestHarbinLine(baiduAk, cfg, refs, { delayMs: 420 });
    const withTimes = harvest.rows.filter(
      (r) => r.downFirst || r.downLast || r.upFirst || r.upLast
    ).length;
    console.log(
      `    ${cfg.short}: ${withTimes}/${harvest.rows.length} stations with times, ` +
        `${harvest.metrics.size} segment pairs measured, ${harvest.misses.length} misses`
    );
    if (harvest.misses.length) {
      console.log(`    ${cfg.short}: misses: ${harvest.misses.slice(0, 8).join(', ')}`);
    }
    harvestedRows.set(cfg.slug, harvest.rows);
    for (const [k, v] of harvest.metrics) {
      if (!metrics.has(k)) metrics.set(k, v);
    }
  }

  const canonical = normalizeHarbin(sources, harvestedRows);

  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let finalStations = stations;
  if (!opts.skipGeocode) {
    finalStations = await fillCoordinates(stations, {
      city: '哈尔滨',
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
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
  }

  // The operator publishes no interchange walk times — the routing default
  // applies until the core gapfill layer measures the walk from a planner
  // route (see packages/core/src/gapfill).
  const transfers = deriveTransfers(finalStations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  let segments = canonical.segments;

  // Planner-measured in-vehicle times win over derived estimates.
  const stationById = new Map(finalStations.map((s) => [s.id, s] as const));
  const stopById = new Map(canonical.stops.map((s) => [s.id, s] as const));
  const harvestedTimes = [];
  for (const pattern of canonical.patterns) {
    for (let i = 0; i + 1 < pattern.stop_ids.length; i++) {
      const a = stopById.get(pattern.stop_ids[i]!);
      const b = stopById.get(pattern.stop_ids[i + 1]!);
      if (!a || !b) continue;
      const na = stationById.get(a.station_id)?.name;
      const nb = stationById.get(b.station_id)?.name;
      if (!na || !nb) continue;
      const key = na < nb ? `${na}|${nb}` : `${nb}|${na}`;
      const m = metrics.get(key);
      if (!m?.durationSeconds || m.durationSeconds <= 0) continue;
      harvestedTimes.push({
        from_stop_id: a.id,
        to_stop_id: b.id,
        travel_time_seconds: m.durationSeconds,
        source_id: 'baidu-transit-direction-v2'
      });
    }
  }
  segments = applyHarvestedSegmentTimes(segments, harvestedTimes).segments;

  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, canonical.timetables, {});
  segments = applyDerivedTimes(segments, derived);
  segments = fillStraightLineDistances(segments, finalStations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(
    segments,
    canonical.patterns,
    canonical.stops,
    canonical.timetables
  );

  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  console.log(`  geocode: subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`);
  console.log(
    `  counts: lines=${canonical.lines.length} stations=${finalStations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines: canonical.lines,
    stations: finalStations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments,
    transfers,
    timetables
  });
  console.log(`  wrote ${outDir}`);

  if (!opts.skipHarvest) {
    await applySegmentDistances(outDir, metrics, canonical.stops, finalStations);
  }

  if (!opts.skipFares) {
    console.log('  compute fares from the official mileage tariff');
    await computeAndWriteFares(outDir);
  }

  const bySrc: Record<string, number> = {};
  for (const s of segments) {
    const k = s.travel_time_source ?? 'none';
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  console.log('segments by time source:', bySrc);
}

/** Apply planner in-vehicle km to segments.json (planner misses keep haversine). */
async function applySegmentDistances(
  dataDir: string,
  metrics: Map<string, SegmentMetric>,
  stops: { id: string; station_id: string }[],
  stations: { id: string; name: string }[]
): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const segmentsPath = join(dataDir, 'segments.json');
  const segDoc = JSON.parse(await readFile(segmentsPath, 'utf-8')) as {
    generated_at?: string;
    records: {
      from_stop_id: string;
      to_stop_id: string;
      distance_km?: number;
      extras?: Record<string, unknown>;
    }[];
  };
  const stopById = new Map(stops.map((s) => [s.id, s] as const));
  const stationById = new Map(stations.map((s) => [s.id, s] as const));
  let applied = 0;
  for (const seg of segDoc.records) {
    const na = stationById.get(stopById.get(seg.from_stop_id)?.station_id ?? '')?.name;
    const nb = stationById.get(stopById.get(seg.to_stop_id)?.station_id ?? '')?.name;
    if (!na || !nb) continue;
    const key = na < nb ? `${na}|${nb}` : `${nb}|${na}`;
    const meters = metrics.get(key)?.distanceMeters;
    if (meters != null && meters > 0) {
      seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
      applied++;
    }
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(`  segment distances applied: ${applied} planner`);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runHarbinNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipHarvest: process.argv.includes('--skip-harvest')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
