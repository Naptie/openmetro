/**
 * Sync pipeline for cn-wuxi.
 *
 * ```
 * fetchAmapSubway() + fetchOfficialSources()
 *   → normalizeWuxi()                            # lines/stations/stops/patterns/segments/network
 *   → harvestLineTimetables() × 5               # Baidu per-station first/last
 *   → normalizeWuxi() (again, with the times)    # the ids are deterministic
 *   → fillStationEnglishNames()
 *   → fillCoordinates()                          # AMap → Overpass → Photon cascade
 *   → deriveTransfers() + the 1↔S1 through-run edges
 *   → normalizeTimetableTimes()
 *   → deriveSegmentTimes() / applyDerivedTimes()
 *   → fillStraightLineDistances() / estimateTimesFromDistanceSpeed() / fillMissingSegmentTimes()
 *   → writeCanonical(outDir, …)
 * ```
 *
 * The first pass is a pure topology pass; the timetable harvest needs the
 * station ids and coordinates, so it runs between two normalizations. Both
 * normalizations derive the same ids from the same sources, so the second one
 * is deterministic.
 *
 * ## Layer order
 *
 * The **fares** layer is deliberately *not* computed here: the tariff is
 * distance-based, so it needs the segment kilometre measurements that the core
 * `gapfill` layer produces. The correct order is
 *
 * ```
 * bun run data:sync --network cn-wuxi --layer topology,timetables,enrichment
 * bun run data:sync --network cn-wuxi --layer gapfill
 * bun run data:sync --network cn-wuxi --layer fares
 * ```
 */
import { join } from 'node:path';
import {
  applyDerivedTimes,
  computeNetworkQuality,
  deriveSegmentTimes,
  deriveTransfers,
  estimateTimesFromDistanceSpeed,
  fillCoordinates,
  fillMissingSegmentTimes,
  fillStationEnglishNames,
  fillStraightLineDistances,
  findRepoRoot,
  type KnownLocation,
  loadBaiduAk,
  normalizeTimetableTimes,
  type SegmentEncoded,
  type StationEncoded,
  writeCanonical
} from '@openmetro/core';

import { amapStationInfo } from './amap.js';
import { fetchBaiduPlaceStation } from './baidu.js';
import { harvestSegmentDistances, type SegmentPairQuery } from './distances.js';
import { fetchAmapSubway, fetchOfficialSources, type OfficialSources } from './fetch.js';
import {
  NOT_YET_OPEN_STATIONS,
  parseWuxiTariff,
  tariffMatchesLadder,
  WUXI_LINES
} from './lines.js';
import { buildThroughRunTransfers, normalizeWuxi, type WuxiCanonical } from './normalize.js';
import { type HarvestStation, harvestLineTimetables } from './timetables.js';

export interface WuxiNormalizeOptions {
  /** Repository root containing `data/cn-wuxi`. */
  root?: string;
  /** Skip the geocoding cascade (dev runs). */
  skipGeocode?: boolean;
  /** Skip the Baidu first/last harvest (dev runs). */
  skipTimetables?: boolean;
}

/**
 * AMap stations re-keyed onto the canonical names, for the geocode cascade.
 *
 * The cascade looks names up exactly, and the canonical names come from the
 * AMap dataset itself, so the re-keying is the identity — but the injection
 * still matters: it removes the dependency on the core's own AMap city-list
 * lookup and guarantees the cascade sees the very same snapshot the adapter
 * parsed.
 */
function subwayStations(canonical: WuxiCanonical): {
  name: string;
  pinyin?: string;
  poiid?: string;
  location: { lon: number; lat: number; crs: 'gcj02' };
}[] {
  const nameById = new Map(canonical.stations.map((s) => [s.id, s.name] as const));
  const out: {
    name: string;
    pinyin?: string;
    poiid?: string;
    location: { lon: number; lat: number; crs: 'gcj02' };
  }[] = [];
  for (const stop of canonical.stops) {
    const station = canonical.stations.find((s) => s.id === stop.station_id);
    if (!station?.location) continue;
    out.push({
      name: nameById.get(stop.station_id) ?? station.name,
      pinyin: typeof station.extras?.pinyin === 'string' ? station.extras.pinyin : undefined,
      poiid: typeof station.extras?.amap_poiid === 'string' ? station.extras.amap_poiid : undefined,
      location: {
        lon: station.location.lon,
        lat: station.location.lat,
        crs: 'gcj02'
      }
    });
  }
  return out;
}

/** Recompute `network.quality` from the final canonical files on disk. */
async function refreshQuality(dataDir: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const read = async (name: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(dataDir, name), 'utf-8'));
  const readOptional = async (name: string) => {
    try {
      return await read(name);
    } catch {
      return undefined;
    }
  };
  const network = await read('network.json');
  const quality = computeNetworkQuality({
    lines: (await read('lines.json')).records as never,
    stations: (await read('stations.json')).records as never,
    stops: (await read('stops.json')).records as never,
    segments: (await read('segments.json')).records as never,
    transfers: (await read('transfers.json')).records as never,
    timetables: (await read('timetables.json')).records as never,
    fares: (await readOptional('fares.json')) as never
  });
  await writeFile(
    join(dataDir, 'network.json'),
    `${JSON.stringify({ ...network, quality }, null, 2)}\n`,
    'utf-8'
  );
  console.log('  refreshed network.quality');
}

/**
 * Check the published ticket rules against the compiled ladder.
 *
 * A tariff change would silently invalidate every computed fare, so the
 * operator's rules are re-read on every sync. A mismatch is reported loudly —
 * it does not fail the sync, because the rest of the network does not depend
 * on it.
 */
function checkTariff(official: OfficialSources | undefined): void {
  if (!official?.ticketing) {
    console.log('  tariff: official rules not read — using the compiled ladder');
    return;
  }
  const text = official.ticketing.columnIntroduce ?? '';
  const bands = parseWuxiTariff(text);
  if (!bands) {
    console.log('  tariff: the published rules could not be parsed — using the compiled ladder');
    return;
  }
  if (!tariffMatchesLadder(bands)) {
    console.warn(
      '  tariff: the published rules no longer match the compiled ladder — ' +
        `published ${JSON.stringify(bands)}, compiled ${JSON.stringify({
          baseYuan: 2,
          baseKm: 5,
          secondKm: 15,
          secondStepKm: 5,
          thirdKm: 29,
          thirdStepKm: 7,
          fourthStepKm: 9
        })}`
    );
    return;
  }
  console.log('  tariff: published rules match the compiled ladder');
}

export async function runWuxiNormalize(opts: WuxiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  const outDir = join(root, 'data/cn-wuxi');

  console.log('  fetch AMap subway dataset (3202)');
  const amap = await fetchAmapSubway();
  const amapStops = (amap.l ?? []).reduce((n, l) => n + (l.st?.length ?? 0), 0);
  console.log(`    ${amap.l?.length ?? 0} lines, ${amapStops} line-stop rows`);

  console.log('  fetch official site (best effort)');
  const official = await fetchOfficialSources();
  for (const warning of official.warnings) {
    console.log(`    WARN official read failed — ${warning}`);
  }
  checkTariff(official);

  const baiduAk = loadBaiduAk();
  if (!baiduAk && !opts.skipTimetables) {
    throw new Error(
      'OPENMETRO_BAIDU_AK is required — Wuxi per-station first/last trains are harvested via Baidu Direction v2 (the operator publishes its timetable sheets only as static images; no OCR).'
    );
  }

  // ---- First pass: the canonical topology ---------------------------------
  const provisional = normalizeWuxi({ amap, harvestedTimes: new Map(), official });

  // ---- Baidu per-station first/last ----------------------------------------
  const harvestedTimes = new Map<string, Awaited<ReturnType<typeof harvestLineTimetables>>>();
  if (!opts.skipTimetables && baiduAk) {
    for (const cfg of WUXI_LINES) {
      const lineId = `cn-wuxi-line-${cfg.slug}`;
      const stops = provisional.stopsByLineId.get(lineId) ?? [];
      const refs: HarvestStation[] = [];
      for (const stop of stops) {
        const station = provisional.stations.find((s) => s.id === stop.station_id);
        const name = stop.extras?.official_name;
        if (!station?.location || typeof name !== 'string') continue;
        refs.push({ name, lon: station.location.lon, lat: station.location.lat });
      }
      if (refs.length < 2) {
        console.log(`    ${cfg.name}: skip Baidu harvest (no coordinates)`);
        continue;
      }
      console.log(`    ${cfg.name}: harvesting first/last via Baidu Direction v2`);
      const rows = await harvestLineTimetables(baiduAk, cfg, refs, {
        delayMs: 120,
        concurrency: 3,
        retries: 2
      });
      const withTimes = rows.filter((r) => r.first || r.last).length;
      const stationsCovered = new Set(
        rows.filter((r) => r.first && r.last).map((r) => r.stationName)
      );
      console.log(
        `    ${cfg.name}: ${withTimes}/${rows.length} directions, ` +
          `${stationsCovered.size}/${refs.length} stations with both first and last`
      );
      harvestedTimes.set(cfg.short, rows);
    }
  }

  // ---- Baidu one-hop segment distances -------------------------------------
  // The official tariff is a **distance** ladder, so the fare matrix cannot be
  // computed from the straight line between two stations. Every adjacent hop is
  // measured with the planner — one query per undirected pair.
  const segmentDistances = new Map<string, number>();
  if (!opts.skipTimetables && baiduAk) {
    const pairs: SegmentPairQuery[] = [];
    for (const cfg of WUXI_LINES) {
      const lineId = `cn-wuxi-line-${cfg.slug}`;
      const stops = provisional.stopsByLineId.get(lineId) ?? [];
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i]!;
        const b = stops[i + 1]!;
        const aName = a.extras?.official_name;
        const bName = b.extras?.official_name;
        if (typeof aName !== 'string' || typeof bName !== 'string') continue;
        const aStation = provisional.stations.find((s) => s.id === a.station_id);
        const bStation = provisional.stations.find((s) => s.id === b.station_id);
        if (!aStation?.location || !bStation?.location) continue;
        pairs.push({
          line: cfg,
          fromStopId: a.id,
          toStopId: b.id,
          from: { name: aName, lon: aStation.location.lon, lat: aStation.location.lat },
          to: { name: bName, lon: bStation.location.lon, lat: bStation.location.lat }
        });
      }
    }
    console.log(`  harvest ${pairs.length} adjacent-hop distances via Baidu Direction v2`);
    const metrics = await harvestSegmentDistances(baiduAk, pairs, {
      delayMs: 100,
      retries: 1,
      concurrency: 3
    });
    const withDistance = metrics.filter((m) => (m.distanceMeters ?? 0) > 0);
    console.log(`    segment distances: ${withDistance.length}/${metrics.length}`);
    for (const m of withDistance) {
      const key =
        m.fromStopId < m.toStopId
          ? `${m.fromStopId}|${m.toStopId}`
          : `${m.toStopId}|${m.fromStopId}`;
      segmentDistances.set(key, (m.distanceMeters ?? 0) / 1000);
    }
  }

  // ---- Second pass: canonical records with the harvested times --------------
  const canonical = normalizeWuxi({ amap, harvestedTimes, segmentDistances, official });

  // ---- English names --------------------------------------------------------
  // AMap already publishes a real English name for all 97 line-stop rows, so
  // Wikidata is only a safety net for whatever the dataset is missing.
  const enFill = await fillStationEnglishNames(canonical.stations);
  const stations: StationEncoded[] = enFill.stations;
  console.log(`  wikidata station names: ${enFill.filled}/${enFill.requested} filled`);

  // ---- Coordinates ----------------------------------------------------------
  // The one station no other source publishes is 安镇 (2 号线's eastern
  // terminus, 暂缓开通 on the operator's network map). A free geocoder guesses
  // wrong for it — Photon resolves the bare name to an unrelated 安镇 several
  // kilometres away — so its coordinate is looked up in Baidu Place (which
  // knows the POI and its `地铁2号线` address) and handed to the cascade as a
  // known location. A station without a verified hit keeps **no** coordinate:
  // a wrong point is worse than none.
  const knownLocations: KnownLocation[] = [];
  const unverifiedNames = new Set<string>();
  if (baiduAk) {
    for (const planned of NOT_YET_OPEN_STATIONS) {
      const hit = await fetchBaiduPlaceStation(baiduAk, planned.name, '无锡').catch(
        () => undefined
      );
      if (hit?.location) {
        knownLocations.push({
          name: planned.name,
          location: { lon: hit.location.lng, lat: hit.location.lat, crs: 'gcj02' },
          source: 'baidu-place'
        });
        console.log(
          `  ${planned.name}: Baidu Place ${hit.name} ${hit.location.lng},${hit.location.lat} (${hit.address})`
        );
      } else {
        unverifiedNames.add(planned.name);
        console.log(`  ${planned.name}: no verified Baidu Place hit — left without a coordinate`);
      }
    }
  }

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  if (!opts.skipGeocode) {
    const located = await fillCoordinates(stations, {
      city: '无锡',
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      knownLocations,
      fetchers: { fetchSubway: async () => subwayStations(canonical) },
      speedValidate: true,
      failOnInvalidCoordinates: false,
      onSubwayMatch: () => subwayMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    });
    for (let i = 0; i < located.length; i++) stations[i] = located[i]!;
  }
  // Drop a guessed coordinate on a not-yet-open station we could not verify.
  // `StationEncoded` is readonly, so the records are rebuilt rather than
  // mutated.
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    if (st.status !== 'under_construction') continue;
    const zh = st.names?.zh ?? '';
    if (!unverifiedNames.has(zh)) continue;
    stations[i] = {
      ...st,
      location: undefined,
      extras: { ...(st.extras ?? {}), location_source: undefined }
    };
  }
  console.log(`  geocode: subway=${subwayMatched} overpass=${overpassMatched} geocode=${geocoded}`);

  // ---- Transfers ------------------------------------------------------------
  // The operator publishes no transfer walk times, so the edges carry none here;
  // the core `gapfill` layer measures them with the Baidu planner. The 1↔S1
  // through-run at 堰桥 is the exception: it is an **official** zero-second
  // edge (the passenger stays on board), and it is handed to `deriveTransfers`
  // as the official list so it lands on the generated edge instead of
  // creating a second edge for the same line pair.
  const transfers = deriveTransfers(
    stations,
    canonical.stops,
    buildThroughRunTransfers(canonical),
    {
      patterns: canonical.patterns,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      routing: canonical.network.routing,
      crossStation: true
    }
  );

  // ---- Segment times --------------------------------------------------------
  // The last-train chain and the distance/speed model only fill the holes; the
  // planner's own in-vehicle measurements arrive with the `gapfill` layer.
  let segments: SegmentEncoded[] = canonical.segments;
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

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log(
    '  operating:',
    stations.filter((s) => s.status === 'operating').length,
    ' under_construction:',
    stations.filter((s) => s.status === 'under_construction').length
  );
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
    'transfers with walk_time:',
    transfers.filter((t) => t.walk_time_seconds != null).length
  );
  console.log('timetables:', timetables.length);
  console.log(
    'timetable rows with both first and last:',
    timetables.filter((t) => t.first_train.length > 0 && t.last_train.length > 0).length
  );

  // The quality block is computed by `writeCanonical`; refresh it once more so
  // the numbers match the final records.
  await refreshQuality(outDir);
}

/** The AMap station info of one record, for callers that need the raw entry. */
export { amapStationInfo };
