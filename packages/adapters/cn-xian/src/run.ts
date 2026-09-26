import { join } from 'node:path';
import {
  applyDerivedTimes,
  deriveSegmentTimes,
  deriveTransfers,
  enrichLineNamesFromWikidata,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  type LineEncoded,
  normalizeTimetableTimes,
  writeCanonical
} from '@openmetro/core';
import { type BaiduStationRef, harvestBaiduTimetables, loadBaiduAk } from './baidu-timetables.js';
import { mergeOfficialFares, writeXianFormulaFares } from './fares.js';
import { fetchXianSources } from './fetch.js';
import { normalizeXian } from './normalize.js';

export interface XianNormalizeOptions {
  root?: string;
  skipGeocode?: boolean;
  skipFares?: boolean;
  /** Skip live getStationInfo harvest (topology-only rebuild). */
  skipStationInfo?: boolean;
  /** Replace formula cells with official OD quotes. */
  harvestOfficialFares?: boolean;
}

export async function runXianNormalize(opts: XianNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-xian');

  const sources = await fetchXianSources({ harvestStationInfo: !opts.skipStationInfo });
  const canonical = normalizeXian(sources);

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.en || line.name
  });

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
      city: '西安',
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
          source_id: t.source_id ?? 'xian-routing-default'
        }
  );

  // Timetables first (official + optional Baidu fill) so segment derivation
  // can use last-train chains from the full set.
  const timetables = canonical.timetables.map((t) => normalizeTimetableTimes(t));

  // Lines the official getStationInfo feed omits: harvest first/last via Baidu
  // Direction Lite (same non-OCR path as cn-nanjing) when OPENMETRO_BAIDU_AK is set.
  const baiduAk = loadBaiduAk();
  if (baiduAk) {
    const withTt = new Set(timetables.map((t) => t.line_id));
    const stationById = new Map(stations.map((s) => [s.id, s]));
    const stopById = new Map(canonical.stops.map((s) => [s.id, s]));
    for (const pattern of canonical.patterns) {
      if (withTt.has(pattern.line_id)) continue;
      const refs: BaiduStationRef[] = [];
      for (const stopId of pattern.stop_ids) {
        const stop = stopById.get(stopId);
        const st = stop ? stationById.get(stop.station_id) : undefined;
        if (!st?.location) continue;
        refs.push({ name: st.name, lon: st.location.lon, lat: st.location.lat });
      }
      if (refs.length < 2) continue;
      console.log(`  baidu timetables ${pattern.line_id} × ${refs.length}`);
      const rows = await harvestBaiduTimetables(baiduAk, refs, { delayMs: 350 });
      const destStop = (name: string) => {
        for (const stopId of pattern.stop_ids) {
          const stop = stopById.get(stopId);
          const st = stop ? stationById.get(stop.station_id) : undefined;
          if (st?.name === name) return stopId;
        }
        return undefined;
      };
      for (const row of rows) {
        if (!row.first && !row.last) continue;
        const stopId = destStop(row.stationName);
        const destStopId = row.destName ? destStop(row.destName) : undefined;
        if (!stopId || !destStopId) continue;
        const stop = stopById.get(stopId)!;
        timetables.push({
          id: `cn-xian-tt-${stopId}-baidu-${row.direction}`,
          station_id: stop.station_id,
          stop_id: stopId,
          line_id: pattern.line_id,
          station_code: stop.source_id,
          source_id: 'baidu-transit',
          destination_stop_id: destStopId,
          pattern_id: pattern.id,
          direction_type: 'linear',
          direction_label: row.destName ? `${row.destName}方向` : undefined,
          first_train: row.first ? [row.first] : [],
          last_train: row.last ? [row.last] : [],
          service: 'all_days',
          extras: { dest_name: row.destName, baidu: true }
        });
      }
    }
  }

  let segments = canonical.segments;
  const derived = deriveSegmentTimes(canonical.patterns, canonical.stops, timetables, {});
  segments = applyDerivedTimes(segments, derived);
  segments = fillStraightLineDistances(segments, stations);
  segments = estimateTimesFromDistanceSpeed(segments);
  segments = fillMissingSegmentTimes(segments, canonical.patterns, canonical.stops, timetables);

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
    // Formula only fills gaps / bootstraps; never clobber official OD quotes.
    await writeXianFormulaFares(outDir, { fillOnly: true });
    if (opts.harvestOfficialFares !== false) {
      try {
        await mergeOfficialFares(outDir, { concurrency: 8, delayMs: 100 });
      } catch (err) {
        console.log(`  official OD merge skipped: ${err}`);
      }
    }
    // Re-stamp quality after fares land.
    const { readFile, writeFile } = await import('node:fs/promises');
    const { computeNetworkQuality } = await import('@openmetro/core');
    const read = async (name: string) => JSON.parse(await readFile(join(outDir, name), 'utf-8'));
    const network = await read('network.json');
    const linesJ = await read('lines.json');
    const stationsJ = await read('stations.json');
    const stopsJ = await read('stops.json');
    const segmentsJ = await read('segments.json');
    const transfersJ = await read('transfers.json');
    const timetablesJ = await read('timetables.json');
    const faresJ = await read('fares.json');
    const quality = computeNetworkQuality({
      lines: linesJ.records,
      stations: stationsJ.records,
      stops: stopsJ.records,
      segments: segmentsJ.records,
      transfers: transfersJ.records,
      timetables: timetablesJ.records,
      fares: faresJ
    });
    await writeFile(
      join(outDir, 'network.json'),
      `${JSON.stringify({ ...network, quality }, null, 2)}\n`,
      'utf-8'
    );
    console.log('  refreshed network.quality after fares');
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
  console.log(
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runXianNormalize({
    skipFares: !process.argv.includes('--fares'),
    skipStationInfo: process.argv.includes('--no-station-info'),
    harvestOfficialFares: !process.argv.includes('--no-official-fares')
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
