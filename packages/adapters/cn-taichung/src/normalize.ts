import {
  entitySchemaUrl,
  type FareMatrixEncoded,
  type LineEncoded,
  type NetworkEncoded,
  normalizeTimetableTimes,
  type PatternEncoded,
  placeholderCity,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';

export type Row = Record<string, string>;
export interface OfficialStation {
  SequenceNo: number;
  ID: string;
  SiteCode: string;
  SiteName: string;
  SiteNameEn: string;
}
export interface TaichungSources {
  officialStations: OfficialStation[];
  stations: Row[];
  runtimes: Row[];
  timetables: Row[];
  fares: Row[];
}

/** RFC4180, including quoted CRLF and the publisher's UTF-8 BOM. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF+/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field);
      field = '';
      if (c !== ',') {
        if (row.some((v) => v.length)) rows.push(row);
        row = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  row.push(field);
  if (row.some((v) => v.length)) rows.push(row);
  const header = rows.shift();
  if (!header) throw new Error('Empty CSV');
  return rows.map((cells) => {
    if (cells.length !== header.length) throw new Error('CSV column count changed');
    return Object.fromEntries(header.map((key, i) => [key.trim(), cells[i]!.trim()]));
  });
}

function positive(value: string | undefined, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}

export function normalizeTaichung(input: TaichungSources) {
  const networkId = 'cn-taichung';
  const lineId = `${networkId}-line-g`;
  const official = [...input.officialStations].sort((a, b) => a.SequenceNo - b.SequenceNo);
  if (official.length < 2) throw new Error('Missing TMRT station list');
  const stations: StationEncoded[] = official.map((s) => {
    // The open CSV repeats G17 for Wuri and HSR Taichung. Join by UUID,
    // taking identity/order from the live operator list instead of fixing a row by hand.
    const geo = input.stations.find((r) => r.網址?.includes(s.ID));
    if (!geo || !s.SiteCode || !s.SiteNameEn.trim()) throw new Error(`Missing station ${s.ID}`);
    return {
      id: `${networkId}-${s.SiteCode.toLowerCase()}`,
      name: s.SiteName.trim(),
      names: { zh: s.SiteName.trim(), en: s.SiteNameEn.trim().replace(/\s+/g, ' ') },
      location: {
        lon: positive(geo.經度, 'longitude'),
        lat: positive(geo.緯度, 'latitude'),
        crs: 'wgs84'
      },
      status: 'operating',
      source_ids: [{ source: 'tmrt-stations', id: s.ID }],
      extras: {
        station_code: s.SiteCode,
        open_data_code: geo.車站編號,
        location_source: 'official',
        names_source: 'official'
      }
    };
  });
  if (new Set(stations.map((s) => s.id)).size !== stations.length)
    throw new Error('Duplicate TMRT identity');
  const byName = new Map(stations.map((s) => [s.name, s]));
  const station = (name: string) => {
    const s = byName.get(name.replace(/^往\s*/, '').trim());
    if (!s) throw new Error(`Unknown TMRT station: ${name}`);
    return s;
  };
  const lines: LineEncoded[] = [
    {
      id: lineId,
      name: '綠線',
      names: { zh: '綠線', en: 'Green Line' },
      aliases: [],
      short_name: 'G',
      color: '#009A44',
      mode: 'metro',
      status: 'operating',
      loop: false,
      source_ids: [{ source: 'tmrt-stations', id: 'G' }]
    }
  ];
  const stops: StopEncoded[] = stations.map((s, i) => ({
    id: `${s.id}-g`,
    station_id: s.id,
    line_id: lineId,
    sequence: i,
    is_terminal: i === 0 || i === stations.length - 1,
    location: s.location,
    source_id: 'tmrt-stations'
  }));
  const patterns: PatternEncoded[] = [
    {
      id: `${lineId}-main`,
      line_id: lineId,
      name: '綠線',
      stop_ids: stops.map((s) => s.id),
      origin_stop_id: stops[0]!.id,
      terminal_stop_id: stops.at(-1)!.id,
      is_primary: true,
      source_ids: [{ source: 'tmrt-stations', id: 'G' }]
    }
  ];
  const segments: SegmentEncoded[] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    for (const [a, b] of [
      [stations[i]!, stations[i + 1]!],
      [stations[i + 1]!, stations[i]!]
    ]) {
      const runtime = input.runtimes.find((r) => r.起站 === a.name && r.迄站 === b.name);
      const fare = input.fares.find((r) => r.起站 === a.name && r.迄站 === b.name);
      if (!runtime || !fare) throw new Error(`Missing TMRT edge ${a.name} -> ${b.name}`);
      segments.push({
        id: `${a.id}-to-${b.id}`,
        line_id: lineId,
        from_stop_id: `${a.id}-g`,
        to_stop_id: `${b.id}-g`,
        from_station_id: a.id,
        to_station_id: b.id,
        direction: 'forward',
        travel_time_seconds: positive(runtime.站間行駛秒數, 'runtime'),
        travel_time_source: 'source',
        distance_km: positive(fare.距離, 'distance'),
        source_id: 'tmrt-runtimes',
        extras: { origin_dwell_seconds: Number(runtime.起站停靠秒數) }
      });
    }
  }
  const timetables: TimetableEncoded[] = input.timetables.map((r) => {
    const s = station(r.車站!);
    const dest = station(r.行駛方向!);
    if (!/^\d{2}:\d{2}$/.test(r.首班車!) || !/^\d{2}:\d{2}$/.test(r.末班車!))
      throw new Error('Missing TMRT timetable');
    return normalizeTimetableTimes({
      id: `${s.id}-tt-${dest.id}`,
      station_id: s.id,
      stop_id: `${s.id}-g`,
      line_id: lineId,
      pattern_id: patterns[0]!.id,
      destination_stop_id: `${dest.id}-g`,
      direction_type: 'linear',
      first_train: [r.首班車!],
      last_train: [r.末班車!],
      source_id: 'tmrt-timetables'
    });
  });
  for (const s of stations)
    if (!timetables.some((t) => t.station_id === s.id))
      throw new Error(`No timetable for ${s.name}`);
  const stationIds = stations.map((s) => s.id).sort();
  const matrix: (number | null)[][] = stationIds.map((a) =>
    stationIds.map((b) => (a === b ? 0 : null))
  );
  for (const r of input.fares) {
    const a = stationIds.indexOf(station(r.起站!).id);
    const b = stationIds.indexOf(station(r.迄站!).id);
    const price = positive(r.全票票價金額, 'fare');
    if (matrix[a]![b] != null && matrix[a]![b] !== price) throw new Error('Conflicting TMRT fare');
    matrix[a]![b] = price;
  }
  for (let i = 0; i < matrix.length; i++)
    for (let j = 0; j < matrix.length; j++) {
      if (matrix[i]![j] == null || matrix[i]![j] !== matrix[j]![i])
        throw new Error('Incomplete/asymmetric TMRT fare matrix');
    }
  const fares = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: networkId,
    generated_at: new Date().toISOString(),
    source: [] as FareMatrixEncoded['source'],
    currency: 'TWD',
    unit: 'TWD',
    station_ids: stationIds,
    fares: matrix
  } satisfies FareMatrixEncoded;
  const network: NetworkEncoded = {
    id: networkId,
    name: '臺中捷運',
    names: { zh: '臺中捷運', en: 'Taichung Metro' },
    city: placeholderCity('CN-7104'),
    country_code: 'TW',
    currency: 'TWD',
    timezone: 'Asia/Taipei',
    coordinate_system: 'wgs84',
    default_units: { distance: 'km', time: 's', speed: 'km/h' },
    routing: { weight: 'time', default_transfer_seconds: 120, max_transfer_seconds: 600 },
    notes:
      'Automatically fetched from TMRT and Taichung open data; unique operator station codes supersede duplicated CSV codes. Directional segment running seconds exclude the separately published origin dwell time.'
  };
  return { network, lines, stations, stops, patterns, segments, transfers: [], timetables, fares };
}
