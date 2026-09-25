import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStraightLineDistances,
  geocodeViaPhoton,
  type LineEncoded,
  normalizeTimetableTimes,
  syncFares,
  writeCanonical
} from '@openmetro/core';

import { geocodeBaiduPlace, harvestBaiduTimetables, loadBaiduAk } from './baidu-timetables.js';
import { fareSpec } from './fares.js';
import { fetchNanjingSources } from './fetch.js';
import { KNOWN_LOCATIONS, normalizeNanjing } from './normalize.js';
import { type ParsedTimetableImage, stationTimesFromBaidu } from './times.js';

export interface NanjingNormalizeOptions {
  /** Repository root containing `data/cn-nanjing`. */
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
}

function rootOfDefault(): string {
  if (process.env.OPENMETRO_ROOT) return process.env.OPENMETRO_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'packages', 'adapters')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

export async function runNanjingNormalize(opts: NanjingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? rootOfDefault();
  const outDir = join(root, 'data/cn-nanjing');

  const sources = await fetchNanjingSources();
  const parsedImages: ParsedTimetableImage[] = [];

  const baiduAk = loadBaiduAk();
  if (!baiduAk) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Nanjing first/last trains are harvested via Baidu Direction Lite (no OCR / no cache).'
    );
  }

  console.log('  harvest first/last trains via Baidu Direction Lite');
  for (const line of sources.lines) {
    const official = (sources.stationsByLine[line.reLineId] ?? [])
      .slice()
      .sort((a, b) => a.stationOrder - b.stationOrder);
    if (official.length < 2) continue;

    const fold = (n: string) =>
      n.trim().replace(/站$/, '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');
    const amapByFold = new Map<string, { lon: number; lat: number }>();
    for (const al of sources.amapSubway.l ?? []) {
      for (const st of al.st ?? []) {
        const n = String(st.n ?? '').trim();
        const sl = String(st.sl ?? '');
        if (!n || !sl) continue;
        const [lonRaw, latRaw] = sl.split(',');
        const lon = Number(lonRaw);
        const lat = Number(latRaw);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        amapByFold.set(fold(n), { lon, lat });
      }
    }

    const refs = official.map((s) => {
      const name = s.stationName.trim();
      const known = KNOWN_LOCATIONS[name] ?? KNOWN_LOCATIONS[fold(name)];
      const amap = amapByFold.get(fold(name));
      return {
        name,
        lon: known?.lon ?? amap?.lon ?? 0,
        lat: known?.lat ?? amap?.lat ?? 0
      };
    });

    for (const r of refs) {
      if (r.lon !== 0) continue;
      try {
        const geo = await geocodeViaPhoton(r.name, '南京');
        if (geo) {
          r.lon = geo.lon;
          r.lat = geo.lat;
        }
      } catch {
        // fall through to Baidu Place
      }
      if (r.lon === 0) {
        try {
          const geo = await geocodeBaiduPlace(baiduAk, r.name);
          if (geo) {
            r.lon = geo.lon;
            r.lat = geo.lat;
          }
        } catch {
          // leave unmatched
        }
      }
    }

    const missing = refs.filter((r) => r.lon === 0).length;
    const usable = refs.filter((r) => r.lon !== 0);
    if (usable.length < 2) {
      console.log(`    ${line.shortName}: skip Baidu (no coords)`);
      continue;
    }
    if (missing > 0) {
      console.log(`    ${line.shortName}: ${missing} stations without coords`);
    }

    const harvested = await harvestBaiduTimetables(baiduAk, usable, {
      delayMs: 200,
      retries: 1
    });
    const rows = stationTimesFromBaidu(
      official.map((s) => s.stationName.trim()),
      harvested
    );
    const withTimes = rows.filter(
      (r) => r.downFirst || r.downLastStd || r.upFirst || r.upLastStd
    ).length;
    console.log(
      `    ${line.shortName}: baidu ${withTimes}/${rows.length} stations (${harvested.length} legs)`
    );
    if (withTimes > 0) {
      parsedImages.push({
        stem: line.shortName,
        rows,
        coverage: { stations: rows.length, withTimes },
        notes: [`baidu-directionlite legs=${harvested.length}`]
      });
    }
  }

  const canonical = normalizeNanjing(sources, parsedImages);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

  let officialMatched = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  let stations = canonical.stations;
  if (!opts.skipGeocode) {
    stations = await fillCoordinates(canonical.stations, {
      city: '南京',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
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
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  }).map((t) =>
    t.walk_time_seconds != null
      ? t
      : {
          ...t,
          walk_time_seconds: defaultTransfer,
          source_id: t.source_id ?? 'njmetro-routing-default'
        }
  );

  let segments = canonical.segments;
  // last_train diffs are a free by-product of first/last harvest; Baidu gapfill
  // (`data:sync --layer gapfill`) is the preferred source for segment times.
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
    `  counts: lines=${lines.length} stations=${stations.length} stops=${canonical.stops.length} ` +
      `patterns=${canonical.patterns.length} segments=${segments.length} transfers=${transfers.length} ` +
      `timetables=${timetables.length}`
  );

  await writeCanonical(outDir, canonical.network.id, {
    network: canonical.network,
    lines,
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
    await syncFares({ dataDir: outDir }, fareSpec, { concurrency: 10, delay: 100 });
  }

  console.log('lines:', lines.length);
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
  runNanjingNormalize({ skipFares: !process.argv.includes('--fares') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
