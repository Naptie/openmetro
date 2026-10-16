import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeCanonical } from '../data/write.js';
import { deriveTransfers } from '../graph/transfers.js';
import type {
  FareMatrixEncoded,
  NetworkEncoded,
  SegmentEncoded,
  TimetableEncoded
} from '../schema/index.js';
import {
  estimateTimesFromDistanceSpeed,
  fillStraightLineDistances
} from '../timetable/estimate.js';
import { parseHHMM } from '../timetable/time.js';
import { fetchFeed } from './feed.js';
import type { FeedTopology } from './feed-data.js';

export interface RailCall {
  station: string;
  arrival?: string;
  departure?: string;
}
export interface RailTrip {
  id: string;
  calls: RailCall[];
  /** When known, this train's actual calling pattern, separate from map geometry. */
  pattern_id?: string;
}
export type RailResourceSource = FareMatrixEncoded['source'][number] & {
  method?: string;
  request_body?: string;
  osm_base?: string;
};

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Project published train calls onto the existing line/pattern model.
 * A snapshot is valid only on its source date. Skipped calls never create
 * departures, and adjacent timings always compare calls of the same train.
 */
export function buildRailSchedule(
  topology: FeedTopology,
  trips: RailTrip[],
  options: {
    source: string;
    date?: string;
    service?: string;
    departureWindow?: { start: number; end: number };
  }
): { timetables: TimetableEncoded[]; segments: SegmentEncoded[] } {
  const stopById = new Map(topology.stops.map((s) => [s.id, s]));
  const windows = new Map<string, TimetableEncoded>();
  const samples = new Map<string, { seconds: number; trip: string }[]>();
  for (const trip of trips) {
    let previous = -1;
    const calls = trip.calls.map((call) => {
      const parse = (value: string | undefined) => {
        if (value == null) return undefined;
        let minutes = parseHHMM(value);
        if (minutes == null) throw new Error(`Invalid rail time ${trip.id}: ${value}`);
        if (previous >= 0 && minutes < previous) minutes += 1440;
        if (minutes < previous || (previous >= 0 && minutes - previous > 720))
          throw new Error(`Non-monotonic rail time ${trip.id}`);
        previous = minutes;
        return minutes;
      };
      const arrival = parse(call.arrival);
      const departure = parse(call.departure);
      if (arrival == null && departure == null) throw new Error(`Missing rail time ${trip.id}`);
      return { ...call, arrival, departure };
    });
    for (const pattern of topology.patterns) {
      if (pattern.extras?.geometry_only || (trip.pattern_id && trip.pattern_id !== pattern.id))
        continue;
      const indices = new Map(pattern.stop_ids.map((id, i) => [stopById.get(id)!.source_id, i]));
      const visits: (typeof calls)[] = [[]];
      for (const call of calls) {
        if (indices.has(call.station)) visits.at(-1)!.push(call);
        else if (visits.at(-1)!.length) visits.push([]);
      }
      for (const served of visits) {
        if (served.length < 2) continue;
        const forward = indices.get(served[1]!.station)! > indices.get(served[0]!.station)!;
        for (let i = 1; i < served.length; i++) {
          const delta = indices.get(served[i]!.station)! - indices.get(served[i - 1]!.station)!;
          if (delta === 0 || delta > 0 !== forward)
            throw new Error(`Rail trip ${trip.id} backtracks on alignment ${pattern.id}`);
        }
        const destination = stopById.get(pattern.stop_ids[indices.get(served.at(-1)!.station)!]!)!;
        for (let i = 0; i < served.length - 1; i++) {
          const call = served[i]!,
            next = served[i + 1]!;
          const stop = stopById.get(pattern.stop_ids[indices.get(call.station)!]!)!;
          const nextStop = stopById.get(pattern.stop_ids[indices.get(next.station)!]!)!;
          if (
            call.departure == null ||
            (options.departureWindow &&
              (call.departure < options.departureWindow.start ||
                call.departure >= options.departureWindow.end))
          )
            continue;
          const id = `${stop.id}-to-${destination.id}${trip.pattern_id ? `-${pattern.id}` : ''}${options.date ? `-${options.date}` : ''}`;
          const time = clock(call.departure);
          const old = windows.get(id);
          if (old) {
            windows.set(id, {
              ...old,
              first_train:
                call.departure < parseHHMM(old.first_train[0]!)! ? [time] : old.first_train,
              last_train: call.departure > parseHHMM(old.last_train[0]!)! ? [time] : old.last_train
            });
          } else
            windows.set(id, {
              id,
              station_id: stop.station_id,
              stop_id: stop.id,
              line_id: stop.line_id,
              station_code: call.station,
              source_id: options.source,
              pattern_id: pattern.id,
              destination_stop_id: destination.id,
              direction_type: 'linear',
              first_train: [time],
              last_train: [time],
              service: options.service,
              valid_from: options.date,
              valid_to: options.date,
              extras: {
                timetable_scope: options.date ? 'dated_snapshot' : 'published_regular_service'
              }
            });
          if (Math.abs(indices.get(next.station)! - indices.get(call.station)!) !== 1) continue;
          // Departure-to-departure includes intermediate dwell in through
          // journeys. A terminal has only an arrival and adds no dwell.
          const end = next.departure ?? next.arrival!;
          const seconds = (end - call.departure) * 60;
          if (seconds <= 0 || seconds > 7200) continue;
          const pair = [stop.id, nextStop.id].sort().join('|');
          const values = samples.get(pair) ?? [];
          values.push({ seconds, trip: trip.id });
          samples.set(pair, values);
        }
      }
    }
  }
  const segments = topology.segments.map((segment) => {
    const values = samples.get([segment.from_stop_id, segment.to_stop_id].sort().join('|'));
    if (!values?.length) return segment;
    values.sort((a, b) => a.seconds - b.seconds);
    const median = values[Math.floor((values.length - 1) / 2)]!;
    const middle = values.length >> 1;
    const seconds =
      values.length % 2
        ? median.seconds
        : (values[middle - 1]!.seconds + values[middle]!.seconds) / 2;
    return {
      ...segment,
      travel_time_seconds: seconds,
      travel_time_source: 'source' as const,
      extras: {
        timing_method: 'median_same_train_departures',
        sample_count: values.length,
        representative_train: median.trip
      }
    };
  });
  return { timetables: [...windows.values()], segments };
}

/** Validate before caching or reusing original bytes; POST bodies are part of the cache key. */
export async function fetchRailResource(
  url: string,
  cacheDir: string,
  init?: RequestInit,
  validate?: (bytes: Uint8Array) => unknown
) {
  const key = createHash('sha256')
    .update(`${init?.method ?? 'GET'}\n${url}\n${init?.body ?? ''}`)
    .digest('hex');
  const path = join(cacheDir, `${key}.bin`);
  const metadataPath = join(cacheDir, `${key}.json`);
  let bytes: Uint8Array, retrievedAt: string;
  try {
    if (process.env.OPENMETRO_REFRESH === '1') throw new Error('Refresh requested');
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > 6 * 3600_000) throw new Error('Expired resource');
    bytes = await readFile(path);
    validate?.(bytes);
    retrievedAt = (JSON.parse(await readFile(metadataPath, 'utf8')) as { retrieved_at: string })
      .retrieved_at;
  } catch {
    bytes = await fetchFeed(url, init, validate);
    retrievedAt = new Date().toISOString();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, bytes);
    await writeFile(metadataPath, JSON.stringify({ retrieved_at: retrievedAt }));
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source: RailResourceSource = {
    name: new URL(url).hostname,
    url,
    version: `sha256:${sha256}`,
    retrieved_at: retrievedAt,
    license: 'unknown',
    license_url: null,
    attribution: new URL(url).hostname,
    ...(init?.method ? { method: init.method, request_body: String(init.body ?? '') } : {})
  };
  return {
    bytes,
    source,
    async discard() {
      await Promise.all([rm(path, { force: true }), rm(metadataPath, { force: true })]);
    }
  };
}

export async function mapRailResources<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
  concurrency = 4
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await run(items[i]!);
      }
    })
  );
  return out;
}

/** Dated rail snapshots and variable services can have explicitly partial
 * first/last coverage. Their quality is computed from actual published rows.
 */
export async function writeRailNetwork(options: {
  root: string;
  dataDir: string;
  network: NetworkEncoded;
  topology: FeedTopology;
  timetables: TimetableEncoded[];
  fares: FareMatrixEncoded;
  sources: FareMatrixEncoded['source'];
}) {
  const { topology, network } = options;
  const segments = estimateTimesFromDistanceSpeed(
    fillStraightLineDistances(topology.segments, topology.stations, { maxKm: 200 })
  );
  const transfers = deriveTransfers(topology.stations, topology.stops, [], {
    patterns: topology.patterns,
    routing: network.routing
  });
  await writeCanonical(
    options.dataDir,
    network.id,
    {
      network: { ...network },
      lines: topology.lines,
      stations: topology.stations,
      stops: topology.stops,
      patterns: topology.patterns,
      segments,
      transfers,
      timetables: options.timetables,
      fares: options.fares
    },
    options.sources
  );
  console.log(
    `[${network.id}] ${topology.lines.length} lines, ${topology.stations.length} stations, ${options.timetables.length} timetables`
  );
}
