import {
  buildFeedTopology,
  buildRailSchedule,
  type FeedStation,
  type GeoPoint,
  htmlText,
  parseHHMM,
  type RailTrip
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import type { TraSources } from './fetch.js';

export const NETWORK_ID = 'cn-taiwan-railway';
const LINE_INFO: Record<string, [string, string, string]> = {
  WL: ['西部幹線（山線）', 'Western Trunk (Mountain)', '#005eb8'],
  'WL-C': ['海岸線', 'Coast Line', '#30a5a0'],
  EL: ['東部幹線', 'Eastern Trunk', '#228b22'],
  SL: ['屏東・南迴線', 'Pingtung / South Link', '#ed7d31'],
  SU: ['蘇澳支線', "Su'ao Branch", '#668c58'],
  PX: ['平溪線', 'Pingxi Line', '#8561a8'],
  NW: ['內灣線', 'Neiwan Line', '#c85c8e'],
  LJ: ['六家線', 'Liujia Line', '#e3a323'],
  JJ: ['集集線', 'Jiji Line', '#9f774a'],
  SH: ['沙崙線', 'Shalun Line', '#a42e3d'],
  SA: ['深澳線', "Shen'ao Line", '#1b9eb5'],
  CZ: ['成追線', 'Chengzhui Line', '#7988b4']
};
export interface TraLine {
  code: string;
  zh: string;
  en: string;
  color: string;
  codes: string[];
}
export interface TraDeparture {
  train: string;
  train_date?: string;
  station: string;
  time: string;
  origin: string;
  destination: string;
  arrival: boolean;
}
const fold = (name: string) => name.replaceAll('臺', '台').trim();

export function parseTraStationNames(html: string): Map<string, string> {
  const list = html.match(/availableTags\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!list) throw new Error('TRA station selector missing');
  const out = new Map<string, string>();
  for (const match of list.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"/g)) {
    const value = match[1] ?? (JSON.parse(`"${match[2]}"`) as string);
    const parts = /^(\d{4})-(.+)$/.exec(value);
    if (!parts) throw new Error(`Invalid TRA station selector ${value}`);
    if (/環島|Surround Island/.test(parts[2]!)) continue;
    out.set(parts[1]!, parts[2]!);
  }
  return out;
}

export function parseTraCatalog(zhHtml: string, enHtml: string) {
  const zh = parseTraStationNames(zhHtml),
    en = parseTraStationNames(enHtml);
  const lines: TraLine[] = [];
  for (const match of zhHtml.matchAll(
    /<div class="line-inner hr lineHr" id="line([^"]+)"[\s\S]*?<\/ul>/g
  )) {
    const info = LINE_INFO[match[1]!];
    if (!info) continue; // depot tracks and retired routes are not passenger lines
    let codes = [...match[0].matchAll(/title="(\d{4})-[^"]+"/g)]
      .map((m) => m[1]!)
      .filter((code) => zh.has(code));
    // The operator's eastern selector lists Badu, then the south-to-north
    // sequence. Attach Badu to Nuannuan, never directly to Taitung.
    if (match[1] === 'EL') {
      if (codes[0] !== '0920' || codes[1] !== '6000')
        throw new Error('TRA eastern station layout changed');
      codes = [codes[0]!, ...codes.slice(1).reverse()];
    }
    if (codes.length < 2 || new Set(codes).size !== codes.length)
      throw new Error(`Invalid TRA route ${match[1]}`);
    lines.push({ code: match[1]!, zh: info[0], en: info[1], color: info[2], codes });
  }
  if (!lines.length) throw new Error('TRA passenger route selector missing');
  const used = new Set(lines.flatMap((line) => line.codes));
  const stations: FeedStation[] = [...used].map((code) => {
    if (!en.has(code)) throw new Error(`TRA English station missing ${code}`);
    return { code, key: code, zh: zh.get(code)!, en: en.get(code)! };
  });
  return { lines, stations };
}

export function parseTraLocation(html: string): GeoPoint {
  const match = /viewStreetMap\?latitude=([\d.]+)&(?:amp;)?longitude=([\d.]+)/.exec(html);
  const lat = Number(match?.[1]),
    lon = Number(match?.[2]);
  if (!(lat > 21 && lat < 26 && lon > 118 && lon < 123))
    throw new Error('TRA official station coordinates missing');
  return { lon, lat, crs: 'wgs84' };
}

export function parseTraDepartures(
  html: string,
  station: string,
  name: string,
  date?: string
): TraDeparture[] {
  const rows: TraDeparture[] = [];
  const seen = new Set<string>();
  const previousDate = date
    ? new Date(Date.parse(`${date}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10)
    : undefined;
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const train = /trainNo=(\d+)/.exec(row[1]!)?.[1];
    if (!train) continue;
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => htmlText(m[1]!));
    const endpoints = /\(([^()]+?)→([^()]+?)\)/.exec(cells[1] ?? '');
    const time = cells[2]?.match(/\b\d{2}:\d{2}\b/)?.[0];
    if (!endpoints || !time || parseHHMM(time) == null || Number(time.slice(0, 2)) > 23)
      throw new Error(`Invalid TRA departure ${station}/${train}`);
    const train_date = /querybytrainno\?rideDate=(\d{4}\/\d{2}\/\d{2})/
      .exec(row[1]!)?.[1]
      ?.replaceAll('/', '-');
    if (!train_date) throw new Error(`TRA running date missing ${station}/${train}`);
    const identity = `${train_date}/${train}`;
    if (seen.has(identity)) throw new Error(`Duplicate TRA train ${station}/${identity}`);
    seen.add(identity);
    const origin = endpoints[1]!.trim(),
      destination = endpoints[2]!.trim();
    // Overnight calls keep the train's origin date, even after 03:00.
    // At the origin itself the train must start on the queried calendar date.
    if (
      date &&
      (train_date > date ||
        train_date < previousDate! ||
        (fold(origin) === fold(name) && train_date !== date))
    )
      throw new Error(`TRA timetable date mismatch ${station}/${identity}; requested ${date}`);
    rows.push({
      train,
      train_date,
      station,
      time,
      origin,
      destination,
      arrival: fold(destination) === fold(name)
    });
  }
  const explicitlyEmpty = /查無符合|無符合|沒有符合/.test(htmlText(html));
  if (
    (!rows.length && !explicitlyEmpty) ||
    (!html.includes('itinerary-controls') && !explicitlyEmpty)
  )
    throw new Error(`TRA station timetable layout missing ${station}`);
  return rows;
}

/** Keep complete calendar pages as train context; filter published departures later.
 * The following page uses extended hours relative to the requested service date.
 */
export function traServiceRows(current: TraDeparture[], following: TraDeparture[]): TraDeparture[] {
  return [
    ...current,
    ...following.map((row) => ({
      ...row,
      time: `${String(Number(row.time.slice(0, 2)) + 24)}:${row.time.slice(3)}`
    }))
  ];
}

/** Reconstruct complete train call order before projecting onto each corridor. */
export function traTrips(rows: TraDeparture[], names: Map<string, string>): RailTrip[] {
  const groups = new Map<string, TraDeparture[]>();
  for (const row of rows) {
    const identity = row.train_date ? `${row.train_date}-${row.train}` : row.train;
    const list = groups.get(identity) ?? [];
    list.push(row);
    groups.set(identity, list);
  }
  return [...groups]
    .filter(([, calls]) => calls.length >= 2)
    .map(([id, calls]) => {
      calls.sort((a, b) => parseHHMM(a.time)! - parseHHMM(b.time)!);
      let start = calls.findIndex(
        (call) => fold(names.get(call.station) ?? '') === fold(call.origin)
      );
      if (start < 0) {
        // A trip whose origin is outside passenger scope still has a unique
        // overnight gap; never rotate every 00:xx train into a fabricated day.
        let largest = -1;
        for (let i = 0; i < calls.length; i++) {
          const next = (i + 1) % calls.length;
          const gap = (parseHHMM(calls[next]!.time)! - parseHHMM(calls[i]!.time)! + 1440) % 1440;
          if (gap > largest) {
            largest = gap;
            start = next;
          }
        }
      }
      const ordered = [...calls.slice(start), ...calls.slice(0, start)];
      return {
        id,
        calls: ordered.map((call) =>
          call.arrival
            ? { station: call.station, arrival: call.time }
            : { station: call.station, departure: call.time }
        )
      };
    });
}

function validateTraSources(raw: TraSources) {
  const catalog = parseTraCatalog(raw.catalog, raw.english);
  const followingDate = new Date(Date.parse(`${raw.date}T12:00:00Z`) + 86400_000)
    .toISOString()
    .slice(0, 10);
  const current = catalog.stations.flatMap((station) =>
    parseTraDepartures(raw.timetables[station.code]!, station.code, station.zh, raw.date)
  );
  const following = catalog.stations.flatMap((station) =>
    parseTraDepartures(
      raw.followingTimetables[station.code]!,
      station.code,
      station.zh,
      followingDate
    )
  );
  // Check complete calendar pages before cutting the 03:00 service window.
  // A previous-day tail may lack its origin, but must still reach its terminus.
  const names = new Map(catalog.stations.map((station) => [station.code, fold(station.zh)]));
  const knownNames = new Set(names.values());
  const callsByTrain = new Map<string, { row: TraDeparture; at: string }[]>();
  for (const [date, rows] of [
    [raw.date, current],
    [followingDate, following]
  ] as const) {
    for (const row of rows) {
      const id = `${row.train_date}-${row.train}`;
      const calls = callsByTrain.get(id) ?? [];
      calls.push({ row, at: `${date}T${row.time}` });
      callsByTrain.set(id, calls);
    }
  }
  for (const [id, calls] of callsByTrain) {
    const first = calls[0]!.row;
    const origin = calls.find(({ row }) => names.get(row.station) === fold(row.origin));
    const terminal = calls.find(({ row }) => row.arrival);
    if (
      (first.train_date! >= raw.date && knownNames.has(fold(first.origin)) && !origin) ||
      (first.train_date! < followingDate && knownNames.has(fold(first.destination)) && !terminal) ||
      calls.some(({ at }) => (origin && at < origin.at) || (terminal && at > terminal.at))
    )
      throw Object.assign(new Error(`TRA inconsistent calendar dates/calls for ${id}`), {
        station_codes: [
          ...new Set([
            ...calls.map(({ row }) => row.station),
            ...catalog.stations
              .filter((station) =>
                [fold(first.origin), fold(first.destination)].includes(fold(station.zh))
              )
              .map((station) => station.code)
          ])
        ]
      });
  }
  return { catalog, current, following };
}

export function normalizeTra(raw: TraSources) {
  const { catalog, current, following } = validateTraSources(raw);
  const departureWindow = { start: 180, end: 1620 };
  const inWindow = (time: string) => {
    const minutes = parseHHMM(time)!;
    return minutes >= departureWindow.start && minutes < departureWindow.end;
  };
  const departures = traServiceRows(current, following);
  // Today's calendar page already contains the previous service day's tail.
  // Keep it under yesterday's validity, without extra requests or redating old files.
  const previousTail = traServiceRows([], current);
  if (!departures.some((row) => inWindow(row.time)))
    throw new Error('TRA service snapshot is empty');
  const names = new Map(catalog.stations.map((station) => [station.code, station.zh]));
  const serving = (rows: TraDeparture[]) =>
    traTrips(rows, names).filter((trip) =>
      trip.calls.some((call) => call.departure != null && inWindow(call.departure))
    );
  const trips = serving(departures),
    tailTrips = serving(previousTail);
  const active = new Set(
    [...trips, ...tailTrips].flatMap((trip) => trip.calls.map((call) => call.station))
  );
  const stations = catalog.stations
    .filter((station) => active.has(station.code))
    .map((station) => ({
      ...station,
      location: parseTraLocation(raw.details[station.code]!)
    }));
  const lines = catalog.lines
    .map((line) => ({ ...line, codes: line.codes.filter((code) => active.has(code)) }))
    .filter((line) => line.codes.length >= 2);
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: 'taiwan-railway',
    lines: lines.map((line) => ({ ...line, mode: 'suburban_rail' })),
    stations: lines.flatMap((line) =>
      line.codes.map((code) => ({
        ...stations.find((station) => station.code === code)!,
        code: `${line.code}-${code}`,
        source_code: code
      }))
    ),
    alignments: lines.map((line) => ({
      id: line.code,
      line: line.code,
      codes: line.codes.map((code) => `${line.code}-${code}`)
    }))
  });
  const schedule = buildRailSchedule(topology, trips, {
    source: 'taiwan-railway',
    date: raw.date,
    departureWindow,
    service: '定期旅客列車'
  });
  const previousDate = new Date(Date.parse(`${raw.date}T12:00:00Z`) - 86400_000)
    .toISOString()
    .slice(0, 10);
  const tail = buildRailSchedule(topology, tailTrips, {
    source: 'taiwan-railway',
    date: previousDate,
    departureWindow,
    service: '前一營運日的跨午夜班次'
  });
  topology.segments = schedule.segments;
  const notes = `台鐵 ${raw.date} 營運日的旅客列車與車站時刻，適用時間為當日 03:00 至翌日 03:00（台北時間）。午夜後班次以 24:xx–26:xx 表示；當日凌晨 00:00–03:00 的班次歸前一營運日。保留海線及各支線；未開行旅客列車的車站不納入。行程耗時為靜態估算，不含候車、班次銜接與訂位；目前未提供台鐵票價。`;
  return {
    topology,
    network: feedNetwork(NETWORK_ID, 'CN-71', '台灣鐵路', 'Taiwan Railway', notes),
    timetables: [...tail.timetables, ...schedule.timetables],
    fares: feedFares(NETWORK_ID, topology, raw.sources, []),
    sources: raw.sources
  };
}
