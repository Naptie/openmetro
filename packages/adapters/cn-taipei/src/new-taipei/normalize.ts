import {
  asciiSlug,
  buildFeedTopology,
  enrichFeedStations,
  type FeedStation,
  htmlText,
  type TimetableEncoded
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import type { NewTaipeiSources } from './fetch.js';

export const NETWORK_ID = 'cn-new-taipei';
export const SOURCE = 'new-taipei-metro';
const fold = (s: string) => s.replaceAll('臺', '台').replace(/站$/, '').replace(/\s+/g, '');

export function parseStationTable(html: string): FeedStation[] {
  const stations: FeedStation[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => htmlText(m[1]!));
    if (!/^(V|K|Y|LB)\d{2}$/.test(cells[1] ?? '')) continue;
    const zh = cells[0]!.endsWith('車站') ? cells[0]! : cells[0]!.replace(/站$/, '');
    stations.push({ code: cells[1]!, key: cells[1]!.toLowerCase(), zh, en: '' });
  }
  if (!stations.length) throw new Error('New Taipei station table missing');
  if (new Set(stations.map((s) => s.code)).size !== stations.length)
    throw new Error('Duplicate New Taipei station code');
  // These official station codes follow the physical alignment, independently
  // of the website's presentation order. Danhai's branch is assembled below.
  return stations.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

export interface DepartureWindow {
  destination: string;
  first: string[];
  last: string[];
  last_transfer_to_bannan?: string;
}

/** ODT paragraphs preserve heading context; spans often split individual digits. */
export function parseDepartureText(
  text: string,
  destinations: Record<string, string>,
  context: {
    defaultDestination?: string;
    platformDestinations?: Record<string, string>;
  } = {}
): DepartureWindow[] {
  const names = Object.entries(destinations);
  const detect = (label: string) =>
    names.filter(
      ([, n]) =>
        fold(label).includes(fold(n)) || (n === '淡水漁人碼頭' && label.includes('漁人碼頭'))
    );
  const windows = new Map<string, number[][]>();
  let days: number[] | undefined;
  let defaultDest = context.defaultDestination;
  let previousHour = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, '').replaceAll('新北產月園區', '新北產業園區');
    if (!line) continue;
    if (line.includes('週六') || line.includes('假日')) days = [5, 6];
    else if (line.includes('平常日') || line.includes('平日')) days = [0, 1, 2, 3, 4];
    const hour = /^(\d{1,2})時[：:]?(.*)$/.exec(line);
    if (!hour) {
      if (/月台|平日|平常日|假日|往/.test(line)) previousHour = -1;
      const platform = /([12一二])月台/.exec(line)?.[1];
      if (platform)
        defaultDest =
          context.defaultDestination ??
          context.platformDestinations?.[platform.replace('一', '1').replace('二', '2')];
      if (line.includes('往')) {
        const matches = detect(line.slice(line.indexOf('往')));
        defaultDest = matches.length === 1 ? matches[0]![0] : undefined;
      }
      continue;
    }
    if (!days) throw new Error(`Missing official timetable day type: ${line}`);
    const h = Number(hour[1]);
    const serviceHour = h < 3 ? h + 24 : h;
    if (serviceHour < previousHour)
      throw new Error(`Non-monotonic official timetable hour: ${line}`);
    previousHour = serviceHour;
    const body = /^[\d、，,]+$/.test(hour[2]!)
      ? `${hour[2]!.replace(/[、，,]+$/, '')}分`
      : hour[2]!;
    for (const m of body.matchAll(/(\d{1,2}(?:[、，,]\d{1,2})*)分(?:往([^，,。]+))?/g)) {
      const matched = m[2] ? detect(m[2]) : [];
      const dest = m[2] ? matched[0]?.[0] : defaultDest;
      if (!dest) throw new Error(`Unresolved departure direction: ${line}`);
      const daily = windows.get(dest) ?? Array.from({ length: 7 }, () => [] as number[]);
      for (const minute of m[1]!.split(/[、，,]/).map(Number)) {
        if (minute > 59 || h > 24) throw new Error(`Invalid official departure ${line}`);
        const t = (h < 3 ? h + 24 : h) * 60 + minute;
        for (const day of days) daily[day]!.push(t);
      }
      windows.set(dest, daily);
    }
  }
  const format = (n: number) =>
    `${Math.floor(n / 60)
      .toString()
      .padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
  if (!windows.size) throw new Error('No official departures parsed');
  return [...windows].map(([destination, days]) => {
    if (days.some((d) => !d.length))
      throw new Error(`Incomplete weekday/weekend departures for ${destination}`);
    return {
      destination,
      first: days.map((d) => format(Math.min(...d))),
      last: days.map((d) => format(Math.max(...d)))
    };
  });
}

export function normalizeNewTaipei(raw: NewTaipeiSources) {
  const input = ['v', 'k', 'y', 'lb'].flatMap((k) => parseStationTable(raw.pages[k]!));
  const stations = enrichFeedStations(input, raw.osm);
  const keyByName = new Map<string, string>();
  for (const s of stations) {
    const key = keyByName.get(fold(s.zh)) ?? asciiSlug(s.en);
    keyByName.set(fold(s.zh), key);
    s.key = key;
  }
  const codes = (prefix: string) =>
    input.filter((s) => s.code.startsWith(prefix.toUpperCase())).map((s) => s.code);
  const v = codes('v');
  const servicePaths = [
    v.filter((c) => Number(c.slice(1)) <= 11),
    [...v.filter((c) => Number(c.slice(1)) <= 9), 'V28', 'V27', 'V26'],
    ...['k', 'y', 'lb'].map(codes)
  ];
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: SOURCE,
    stations,
    lines: [
      { code: 'V', zh: '淡海輕軌', en: 'Danhai Light Rail', color: '#a6cf63', mode: 'light_rail' },
      { code: 'K', zh: '安坑輕軌', en: 'Ankeng Light Rail', color: '#c2b783', mode: 'light_rail' },
      { code: 'Y', zh: '環狀線', en: 'Circular Line', color: '#ffdb00', mode: 'metro' },
      { code: 'LB', zh: '三鶯線', en: 'Sanying Line', color: '#88bfe5', mode: 'metro' }
    ],
    alignments: [
      { id: 'v-main', line: 'V', codes: v.filter((c) => Number(c.slice(1)) <= 11) },
      { id: 'v-blue', line: 'V', codes: ['V09', 'V28', 'V27', 'V26'] },
      ...['k', 'y', 'lb'].map((k) => ({ id: k, line: k.toUpperCase(), codes: codes(k) }))
    ]
  });
  const timetables: TimetableEncoded[] = [];
  const seenStations = new Set<string>();
  for (const doc of raw.departures) {
    const stop = topology.stopByCode.get(doc.code);
    if (!stop) throw new Error(`Unknown New Taipei timetable station ${doc.code}`);
    if (seenStations.has(doc.code)) throw new Error(`Duplicate official timetable ${doc.code}`);
    seenStations.add(doc.code);
    const terminals = [
      ...new Set(
        servicePaths.filter((p) => p.includes(doc.code)).flatMap((p) => [p[0]!, p.at(-1)!])
      )
    ].filter((c) => c !== doc.code);
    const choices = Object.fromEntries(
      input.filter((s) => terminals.includes(s.code)).map((s) => [s.code, s.zh])
    );
    const windows =
      doc.windows ??
      parseDepartureText(doc.text, choices, {
        defaultDestination: terminals.length === 1 ? terminals[0] : undefined,
        platformDestinations: doc.code.startsWith('Y') ? { '1': 'Y20', '2': 'Y07' } : undefined
      });
    const seenDestinations = new Set<string>();
    for (const w of windows) {
      const dest = topology.stopByCode.get(w.destination);
      if (!dest || dest.line_id !== stop.line_id || dest.id === stop.id)
        throw new Error(`Invalid New Taipei timetable destination ${doc.code}->${w.destination}`);
      if (seenDestinations.has(dest.id))
        throw new Error(`Duplicate New Taipei timetable direction ${doc.code}->${w.destination}`);
      seenDestinations.add(dest.id);
      const time = /^(?:[01]\d|2[0-6]):[0-5]\d$/;
      if (
        w.first.length !== 7 ||
        w.last.length !== 7 ||
        Array.from({ length: 7 }, (_, i) => i).some(
          (i) =>
            !time.test(w.first[i] ?? '') || !time.test(w.last[i] ?? '') || w.first[i]! >= w.last[i]!
        )
      )
        throw new Error(
          `Incomplete or invalid seven-day official timetable ${doc.code}->${w.destination}`
        );
      const p =
        topology.patterns.find(
          (p) => p.stop_ids.includes(stop.id) && p.stop_ids.includes(dest.id)
        ) ??
        topology.patterns.find((p) => p.line_id === stop.line_id && p.stop_ids.includes(stop.id));
      if (!p) throw new Error(`Unknown New Taipei timetable alignment ${doc.code}`);
      timetables.push({
        id: `${NETWORK_ID}-tt-${doc.code.toLowerCase()}-${w.destination.toLowerCase()}`,
        station_id: stop.station_id,
        stop_id: stop.id,
        line_id: stop.line_id,
        station_code: doc.code,
        destination_stop_id: dest.id,
        pattern_id: p.id,
        direction_type: 'linear',
        first_train: w.first,
        last_train: w.last,
        source_id: doc.url,
        last_train_desc: w.last_transfer_to_bannan
          ? `轉乘板南線最晚須於 ${w.last_transfer_to_bannan} 發車；此時間與末班車分開列示。`
          : undefined,
        extras: {
          holiday_schedule: 'weekend',
          ...(doc.sha256
            ? {
                last_transfer_to_bannan: w.last_transfer_to_bannan,
                source_sha256: doc.sha256,
                extraction:
                  'automatic OCR of the current official raster; validated source station, direction, day headings, grid, hours and confidence'
              }
            : {})
        },
        first_train_desc: '平日與週末分別適用不同班表，國定假日依假日班表行駛。'
      });
    }
  }
  if (!timetables.length) throw new Error('New Taipei timetable feed is empty');
  if (raw.runtimePairs) {
    const pairKey = (a: string, b: string) => [a, b].sort().join('|');
    const runtime = new Map<string, (typeof raw.runtimePairs)[number]>();
    for (const value of raw.runtimePairs) {
      const from = topology.stopByCode.get(value.from),
        to = topology.stopByCode.get(value.to);
      if (!from || !to || from.line_id !== to.line_id || from.id === to.id)
        throw new Error(`Invalid official running-time stations ${value.from}->${value.to}`);
      if (!Number.isFinite(value.seconds) || value.seconds <= 0)
        throw new Error(`Invalid official running time ${value.from}->${value.to}`);
      const key = pairKey(from.id, to.id);
      if (runtime.has(key) && runtime.get(key)!.seconds !== value.seconds)
        throw new Error(`Conflicting official running time ${value.from}->${value.to}`);
      runtime.set(key, value);
    }
    for (const segment of topology.segments) {
      const value = runtime.get(pairKey(segment.from_stop_id, segment.to_stop_id));
      if (!value) continue;
      Object.assign(segment, {
        travel_time_seconds: value.seconds,
        travel_time_source: 'source',
        source_id: value.url,
        extras: { source_sha256: value.sha256 }
      });
    }
  }
  const pairs = raw.farePairs.map((value) => {
    const from = topology.stationByCode.get(value.from)?.id,
      to = topology.stationByCode.get(value.to)?.id;
    if (!from || !to)
      throw new Error(`Official fare references unknown station ${value.from}->${value.to}`);
    return { from, to, price: value.price };
  });
  const sources = [
    ...(raw.calendarSource ? [raw.calendarSource] : []),
    {
      name: SOURCE,
      url: 'https://www.ntmetro.com.tw/',
      version: 'live',
      retrieved_at: new Date().toISOString(),
      license: 'custom' as const,
      license_url: 'https://www.ntmetro.com.tw/basic/?node=11',
      attribution: '新北大眾捷運股份有限公司',
      notes:
        'Official station tables, V/K ODT departures, current Y PDF timetables, Sanying aggregate timetable image, all four runtime matrices and fare posters; numeric raster content is extracted automatically.'
    },
    {
      name: 'openstreetmap',
      url: 'https://www.openstreetmap.org/copyright',
      version: raw.osm.osm3s?.timestamp_osm_base ?? 'provided-snapshot',
      retrieved_at: new Date().toISOString(),
      license: 'odbl' as const,
      license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© OpenStreetMap contributors',
      notes: 'WGS84 station coordinates and English-name enrichment.'
    },
    ...(raw.sourceImages ?? []).map((image) => ({
      name: image.name,
      url: image.url,
      version: image.sha256,
      retrieved_at: new Date().toISOString(),
      license: 'custom' as const,
      license_url: 'https://www.ntmetro.com.tw/basic/?node=11',
      attribution: '新北大眾捷運股份有限公司',
      notes: 'Automatically read current official raster source; SHA256 is a provenance/cache key.'
    }))
  ];
  return {
    topology,
    timetables,
    sources,
    fares: feedFares(NETWORK_ID, topology, sources, pairs),
    network: {
      ...feedNetwork(
        NETWORK_ID,
        'CN-7102',
        '新北捷運',
        'New Taipei Metro',
        '涵蓋淡海輕軌、安坑輕軌、環狀線已通車路段及三鶯線。提供各站首末班車與各線票價；跨營運商路線與聯程票價尚未整合。國定假日採假日班表，臨時調整及特殊活動請以營運公告為準。'
      ),
      service_calendar: raw.serviceCalendar
    }
  };
}
