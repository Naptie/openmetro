import {
  asciiSlug,
  buildFeedTopology,
  deriveCumulativeTimes,
  enrichFeedStations,
  type FeedStation,
  htmlText,
  normalizeTimetableTimes,
  parseHHMM,
  type TimetableEncoded
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import type { TaoyuanSources } from './fetch.js';

export const NETWORK_ID = 'cn-taoyuan';
export type TaoyuanService = 'commuter' | 'express';
export interface PlannerQuote {
  from: string;
  to: string;
  price: number;
  seconds: number;
}

export function parseTaoyuanQuotes(
  raw: unknown,
  service: TaoyuanService = 'commuter'
): PlannerQuote[] {
  const doc = raw as {
    status: string;
    data: Record<
      string,
      {
        start_station: string;
        end_station: string;
        car_type: number;
        car_price: number;
        go_time: string;
      }
    >;
  };
  if (doc.status !== 'success' || !doc.data) throw new Error('Taoyuan official planner failed');
  return Object.values(doc.data)
    .filter((q) => Number(q.car_type) === (service === 'commuter' ? 1 : 2))
    .map((q) => {
      const minutes = /^(\d+)分$/.exec(q.go_time.trim());
      if (!minutes || !Number.isFinite(Number(q.car_price)))
        throw new Error('Taoyuan planner quote format changed');
      return {
        from: q.start_station.replace(/^station_/, ''),
        to: q.end_station.replace(/^station_/, ''),
        price: Number(q.car_price),
        seconds: Number(minutes[1]) * 60
      };
    });
}

export function parseTaoyuanStations(html: string, active: Set<string>): FeedStation[] {
  const out = new Map<string, FeedStation>();
  for (const tag of html.matchAll(/<a\b[^>]*data-station-id="[^"]+"[^>]*>/g)) {
    const attr = (name: string) => tag[0].match(new RegExp(`${name}="([^"]*)"`))?.[1]?.trim();
    const code = attr('data-station-id')!;
    if (!active.has(code)) continue;
    const zh = attr('data-zh-name'),
      en = attr('data-en-name');
    if (!zh || !en) throw new Error(`Taoyuan bilingual station missing ${code}`);
    out.set(code, { code, key: asciiSlug(en), zh, en });
  }
  if (!out.size) throw new Error('Taoyuan station picker missing');
  for (const code of active)
    if (!out.has(code)) throw new Error(`Taoyuan active station missing from picker: ${code}`);
  return [...out.values()].sort(
    (a, b) =>
      Number.parseInt(a.code.slice(1), 10) - Number.parseInt(b.code.slice(1), 10) ||
      a.code.localeCompare(b.code)
  );
}

function serviceSection(html: string, service: TaoyuanService): string {
  const label = service === 'commuter' ? '普通車' : '直達車';
  const start = html.search(new RegExp(`<h4[^>]*>\\s*${label}\\s*</h4>`));
  if (start < 0) throw new Error(`Taoyuan ${service} timetable missing`);
  return html.slice(html.indexOf('</h4>', start) + 5).split(/<h4\b/)[0]!;
}

export function parseTaoyuanDepartures(
  html: string,
  service: TaoyuanService = 'commuter'
): { destination: string; first: string; last: string }[] {
  const section = serviceSection(html, service);
  let kind: 'first' | 'last' = 'first';
  const times = new Map<string, { destination: string; first: string; last: string }>();
  const headings = new Set<string>();
  const declared = new Map<string, Set<string>>();
  for (const block of section.matchAll(
    /<div class="d_table">([\s\S]*?)<\/div>\s*<ul>([\s\S]*?)<\/ul>/g
  )) {
    const label = htmlText(block[1]!);
    if (label === '首班車') kind = 'first';
    else if (label === '末班車') kind = 'last';
    else continue;
    headings.add(kind);
    for (const li of block[2]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const text = htmlText(li[1]!),
        m = /往(A\d+[a-z]?)[^\d]*(\d{2}:\d{2})/.exec(text);
      const destination = /往(A\d+[a-z]?)/.exec(text)?.[1];
      if (destination) {
        const kinds = declared.get(destination) ?? new Set<string>();
        if (kinds.has(kind))
          throw new Error(`Duplicate Taoyuan ${kind} destination ${destination}`);
        kinds.add(kind);
        declared.set(destination, kinds);
      }
      if (!m) {
        if (/\d{1,2}:\d{2}/.test(text)) throw new Error(`Unrecognized Taoyuan departure: ${text}`);
        continue;
      }
      if (parseHHMM(m[2]!) == null) throw new Error(`Invalid Taoyuan time ${m[2]}`);
      const row = times.get(m[1]!) ?? { destination: m[1]!, first: '', last: '' };
      if (row[kind]) throw new Error(`Duplicate Taoyuan ${kind} departure to ${m[1]}`);
      row[kind] = m[2]!;
      times.set(m[1]!, row);
    }
  }
  const rows = [...times.values()];
  if ([...declared.values()].some((kinds) => kinds.size !== 2))
    throw new Error('Incomplete Taoyuan declared destination columns');
  if (
    headings.size !== 2 ||
    (service === 'commuter' && !rows.length) ||
    rows.some((r) => !r.first || !r.last)
  )
    throw new Error('Incomplete Taoyuan first/last train pair');
  return rows;
}

export function normalizeTaoyuan(raw: TaoyuanSources) {
  const quotes = raw.quotes.flatMap((q) => parseTaoyuanQuotes(q));
  const expressQuotes = raw.quotes.flatMap((q) => parseTaoyuanQuotes(q, 'express'));
  const active = new Set(quotes.filter((q) => q.seconds > 0).flatMap((q) => [q.from, q.to]));
  const stations = enrichFeedStations(parseTaoyuanStations(raw.stationPage, active), raw.osm);
  const expressSet = new Set(
    expressQuotes.filter((q) => q.seconds > 0).flatMap((q) => [q.from, q.to])
  );
  if (expressSet.size < 2) throw new Error('Taoyuan express planner is incomplete');
  for (const code of expressSet)
    if (!active.has(code)) throw new Error(`Unknown express station ${code}`);
  const expressStations = stations.filter((s) => expressSet.has(s.code));
  const key = (code: string, service: TaoyuanService) =>
    service === 'express' ? `${code}-express` : code;
  const byService = { commuter: stations, express: expressStations };
  const quoteByService = { commuter: quotes, express: expressQuotes };
  for (const service of ['commuter', 'express'] as const) {
    const pairs = new Map<string, number>();
    for (const q of quoteByService[service]) {
      if (q.from === q.to) continue;
      if (!active.has(q.from) || !active.has(q.to) || !Number.isFinite(q.price) || q.price <= 0)
        throw new Error(`Invalid Taoyuan ${service} fare ${q.from}->${q.to}`);
      const pair = [q.from, q.to].sort().join('|');
      if (pairs.has(pair) && pairs.get(pair) !== q.price)
        throw new Error(`Conflicting Taoyuan fare ${pair}`);
      pairs.set(pair, q.price);
    }
  }
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: 'taoyuan-metro',
    stations: [
      ...stations,
      ...expressStations.map((s) => ({ ...s, code: key(s.code, 'express'), source_code: s.code }))
    ],
    lines: [
      {
        code: 'A',
        zh: '機場捷運（普通車）',
        en: 'Taoyuan Airport MRT (Commuter)',
        color: '#0072bc',
        mode: 'metro'
      },
      {
        code: 'A-express',
        zh: '機場捷運（直達車）',
        en: 'Taoyuan Airport MRT (Express)',
        color: '#8246af',
        mode: 'airport_express'
      }
    ],
    alignments: [
      { id: 'a-commuter', line: 'A', codes: stations.map((s) => s.code) },
      {
        id: 'a-express',
        line: 'A-express',
        codes: expressStations.map((s) => key(s.code, 'express'))
      }
    ]
  });
  topology.lines = topology.lines.map((l) => ({
    ...l,
    short_name: l.id.endsWith('-express') ? 'A 直達' : 'A 普通'
  }));
  // Express trains skip calls, not the intervening airport corridor. Keep
  // their stopping/routing graph separate and share only the map alignment.
  const commuterPattern = topology.patterns.find((p) => p.line_id === `${NETWORK_ID}-line-a`)!;
  topology.patterns = topology.patterns.map((p) =>
    p.line_id.endsWith('-express') ? { ...p, geometry_reference_pattern_id: commuterPattern.id } : p
  );
  // Planner pairs are unordered. Difference the remaining journey to the
  // destination terminal; summing rounded adjacent quotes loses dwell time.
  const times = Object.fromEntries(
    (['commuter', 'express'] as const).map((service) => [
      service,
      deriveCumulativeTimes(
        byService[service].map((s) => s.code),
        quoteByService[service].flatMap((q) =>
          q.from === q.to ? [] : [q, { from: q.to, to: q.from, seconds: q.seconds }]
        )
      ).map(({ from, to, seconds }) => ({ from: to, to: from, seconds }))
    ])
  );
  topology.segments = topology.segments.flatMap((segment) => {
    const a = topology.stops.find((s) => s.id === segment.from_stop_id)!,
      b = topology.stops.find((s) => s.id === segment.to_stop_id)!;
    const service = segment.line_id.endsWith('-express') ? 'express' : 'commuter';
    return [
      [a, b],
      [b, a]
    ].map(([from, to], i) => ({
      ...segment,
      id: `${segment.id}-${i === 0 ? 'forward' : 'backward'}`,
      from_stop_id: from!.id,
      to_stop_id: to!.id,
      from_station_id: from!.station_id,
      to_station_id: to!.station_id,
      direction: 'forward' as const,
      travel_time_seconds: times[service]!.find(
        (q) => q.from === from!.source_id && q.to === to!.source_id
      )!.seconds,
      travel_time_source: 'planner' as const,
      source_id: `tymetro-planner/${service}`,
      extras: { ...segment.extras, planner_time_source: 'tymetro-cumulative-difference' }
    }));
  });
  const timetables: TimetableEncoded[] = [];
  const days = [...raw.departureDays].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) throw new Error('Taoyuan service dates are empty');
  const dayIndex = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const groups = new Map<
    string,
    {
      code: string;
      service: TaoyuanService;
      destination: string;
      windows: Map<string, { first: string; last: string }>;
    }
  >();
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !Number.isFinite(Date.parse(day.date)) ||
      (i > 0 && Date.parse(day.date) - Date.parse(days[i - 1]!.date) !== 86400_000)
    )
      throw new Error('Taoyuan service dates are invalid or not consecutive');
    for (const station of stations) {
      const html = day.pages[station.code];
      if (!html) throw new Error(`Taoyuan timetable page missing ${station.code} on ${day.date}`);
      const heading = html.match(/<h3[^>]*>\s*(A\d+[a-z]?)[^<]*<\/h3>/)?.[1];
      if (heading !== station.code)
        throw new Error(`Taoyuan timetable station mismatch ${station.code}`);
      for (const service of ['commuter', 'express'] as const) {
        const rows = parseTaoyuanDepartures(html, service);
        if (service === 'express' && !expressSet.has(station.code)) {
          if (rows.length)
            throw new Error(`Express timetable/planner station set disagrees at ${station.code}`);
          continue;
        }
        const order = byService[service].map((s) => s.code),
          at = order.indexOf(station.code);
        for (const row of rows) {
          const destIndex = order.indexOf(row.destination);
          if (destIndex < 0 || destIndex === at)
            throw new Error(`Unknown Taoyuan ${service} destination ${row.destination}`);
          const groupKey = `${service}|${station.code}|${row.destination}`;
          const g = groups.get(groupKey) ?? {
            code: station.code,
            service,
            destination: row.destination,
            windows: new Map()
          };
          const normalized = normalizeTimetableTimes({
            first_train: [row.first],
            last_train: [row.last]
          });
          g.windows.set(day.date, {
            first: normalized.first_train[0]!,
            last: normalized.last_train[0]!
          });
          groups.set(groupKey, g);
        }
      }
    }
  }
  for (const g of groups.values()) {
    const stop = topology.stopByCode.get(key(g.code, g.service))!;
    const dest = topology.stopByCode.get(key(g.destination, g.service))!;
    const weekly = Array.from({ length: 7 }, (_, weekday) => {
      const values = days
        .filter((d) => dayIndex(d.date) === weekday)
        .map((d) => g.windows.get(d.date));
      return values.find((value) => value != null);
    });
    const overrides = Object.fromEntries(
      days.map((d) => {
        const w = g.windows.get(d.date);
        return [d.date, w ? { first_train: w.first, last_train: w.last } : null];
      })
    );
    timetables.push({
      id: `${NETWORK_ID}-tt-${g.code.toLowerCase()}-${g.destination.toLowerCase()}${g.service === 'express' ? '-express' : ''}`,
      station_id: stop.station_id,
      stop_id: stop.id,
      line_id: stop.line_id,
      station_code: g.code,
      destination_stop_id: dest.id,
      pattern_id: topology.patterns.find((p) => p.line_id === stop.line_id)!.id,
      direction_type: 'linear',
      service: g.service,
      first_train: weekly.map((w) => w?.first ?? ''),
      last_train: weekly.map((w) => w?.last ?? ''),
      valid_from: days[0]!.date,
      valid_to: days.at(-1)!.date,
      first_train_desc: '依所選服務日期查詢；普通車與直達車分列。',
      extras: { date_overrides: overrides },
      source_id: `https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/departure.php?station=${g.code}`
    });
  }
  const sources = [
    ...raw.sources,
    {
      name: 'openstreetmap',
      url: 'https://www.openstreetmap.org/copyright',
      version: raw.osm.osm3s?.timestamp_osm_base ?? 'provided-snapshot',
      retrieved_at: new Date().toISOString(),
      license: 'odbl' as const,
      license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© OpenStreetMap contributors',
      notes: 'WGS84 station coordinates.'
    }
  ];
  const pairs = [...quotes, ...expressQuotes].flatMap((q) => {
    const from = topology.stationByCode.get(q.from)?.id,
      to = topology.stationByCode.get(q.to)?.id;
    return from && to ? [{ from, to, price: q.price }] : [];
  });
  return {
    topology,
    timetables,
    sources,
    fares: feedFares(NETWORK_ID, topology, sources, pairs),
    network: feedNetwork(
      NETWORK_ID,
      'CN-7103',
      '桃園捷運',
      'Taoyuan Metro',
      `機場捷運普通車與直達車分開顯示，共用車站可轉乘。首末班依日期查詢，適用 ${days[0]!.date} 至 ${days.at(-1)!.date}；特殊加班與臨時營運調整以桃捷公告為準。票價為成人單程票；跨台北、新北捷運的旅程需另行查詢。`
    )
  };
}
