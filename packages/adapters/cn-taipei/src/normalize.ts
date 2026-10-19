import {
  asciiSlug,
  buildFeedTopology,
  deriveTransfers,
  type FeedStation,
  parseCsv,
  parseHHMM,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import { feedFares, feedNetwork } from '@openmetro/taiwan-shared';
import { TAIPEI_DATASETS, type TaipeiDataset, type TaipeiSources } from './fetch.js';

export const NETWORK_ID = 'cn-taipei';
const SOURCE = 'taipei-open-data';
const strip = (s: string) => s.trim().replace(/^'|'$/g, '');
const nameKey = (s: string) => s.replaceAll('臺', '台').trim();

const LINES = [
  { code: 'BR', zh: '文湖線', en: 'Wenhu Line', color: '#c48c31', mode: 'metro' as const },
  {
    code: 'R',
    zh: '淡水信義線',
    en: 'Tamsui-Xinyi Line',
    color: '#e3002c',
    mode: 'metro' as const
  },
  {
    code: 'G',
    zh: '松山新店線',
    en: 'Songshan-Xindian Line',
    color: '#008659',
    mode: 'metro' as const
  },
  {
    code: 'O',
    zh: '中和新蘆線',
    en: 'Zhonghe-Xinlu Line',
    color: '#f8b61c',
    mode: 'metro' as const
  },
  { code: 'BL', zh: '板南線', en: 'Bannan Line', color: '#0070bd', mode: 'metro' as const }
];

export function normalizeTaipei(raw: TaipeiSources) {
  const rows = Object.fromEntries(
    Object.keys(TAIPEI_DATASETS).map((key) => [key, parseCsv(raw[key as TaipeiDataset])])
  ) as Record<TaipeiDataset, Record<string, string>[]>;
  const stations: FeedStation[] = [];
  const byName = new Map<string, FeedStation>();
  for (const row of rows.stations) {
    const names = strip(row.StationName!).replace(/^{|}$/g, '').split(',');
    const zh = names[0]!.trim(),
      en = names.slice(1).join(',').trim();
    const coords = strip(row.StationPosition!).replace(/^{|}$/g, '').split(',').map(Number);
    if (!en || !coords.every(Number.isFinite))
      throw new Error(`Invalid Taipei station ${row.StationID}`);
    const base = {
      key: asciiSlug(en),
      zh,
      en,
      source: `${SOURCE}-stations`,
      location: { lon: coords[0]!, lat: coords[1]!, crs: 'wgs84' as const }
    };
    for (const code of strip(row.StationID!).split(',')) {
      const station = { ...base, code: code.trim() };
      stations.push(station);
      byName.set(nameKey(zh), station);
    }
  }
  const knownCodes = new Set(stations.map((s) => s.code));
  const alignments = rows.routes
    .filter((r) => r.Direction === '0')
    .map((r) => {
      const codes: string[] = [];
      for (const m of r.Stations!.matchAll(/\d+,([A-Z]+\d+[A-Z]?),([^']+)/g)) {
        const code = m[1]!,
          label = m[2]!.trim();
        if (!knownCodes.has(code)) {
          const station =
            byName.get(nameKey(label)) ?? byName.get(nameKey(label.replace(/站$/, '')));
          if (!station) throw new Error(`Missing Taipei station ${code}: ${label}`);
          stations.push({ ...station, code });
          knownCodes.add(code);
        }
        codes.push(code);
      }
      return { id: strip(r.RouteID!), line: strip(r.LineID!), codes };
    });
  if (!alignments.length) throw new Error('Taipei route feed is empty');
  const topology = buildFeedTopology({
    networkId: NETWORK_ID,
    source: `${SOURCE}-routes`,
    lines: LINES,
    stations,
    alignments
  });
  const directions = new Set<string>();
  const timetables: TimetableEncoded[] = rows.timetables.map((r) => {
    let code = strip(r.StationID!);
    const destCode = strip(r.DestinationStaionID!);
    // Official CSV 2026-08-30 swaps the boarding codes of the two G03/G03A shuttle rows.
    // The headsign, destination name and destination code agree; preserve those fields.
    const corrected = code === destCode && (code === 'G03' || code === 'G03A');
    if (corrected) code = code === 'G03' ? 'G03A' : 'G03';
    const stop = topology.stopByCode.get(code),
      dest = topology.stopByCode.get(destCode);
    if (!stop || !dest || stop.line_id !== dest.line_id || stop.id === dest.id)
      throw new Error(`Invalid Taipei timetable ${code} -> ${destCode}`);
    const direction = `${code} -> ${destCode}`;
    if (directions.has(direction))
      throw new Error(`Duplicate Taipei timetable direction ${direction}`);
    directions.add(direction);
    const pattern =
      topology.patterns.find(
        (p) =>
          p.line_id === stop.line_id && p.stop_ids.includes(stop.id) && p.stop_ids.includes(dest.id)
      ) ??
      topology.patterns.find((p) => p.line_id === stop.line_id && p.stop_ids.includes(stop.id));
    if (!pattern) throw new Error(`Missing Taipei timetable pattern for ${code}`);
    const days = strip(r.ServiceDays ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .filter(Boolean);
    if (days.length < 7 || days.slice(0, 7).some((d) => d !== '1'))
      throw new Error('Taipei service-day format changed; refusing to publish daily times');
    const first = strip(r.FirstTrainTime ?? ''),
      last = strip(r.LastTrainTime ?? '');
    if (parseHHMM(first) == null || parseHHMM(last) == null)
      throw new Error(`Invalid Taipei timetable times ${direction}: ${first}/${last}`);
    return {
      id: `${NETWORK_ID}-tt-${r.SEQNO}`,
      station_id: stop.station_id,
      stop_id: stop.id,
      line_id: stop.line_id,
      station_code: code,
      destination_stop_id: dest.id,
      pattern_id: pattern.id,
      direction_type: 'linear',
      direction_label: strip(r.TripHeadSign!),
      first_train: [first],
      last_train: [last],
      source_id: `${SOURCE}-timetables/${r.SEQNO}`,
      extras: {
        update_time: strip(r.UpdateTime!),
        ...(corrected
          ? {
              correction: 'source boarding code swapped on G03/G03A shuttle',
              original_station_code: strip(r.StationID!)
            }
          : {})
      }
    };
  });
  if (!timetables.length) throw new Error('Taipei timetable feed is empty');

  const sources = (Object.keys(TAIPEI_DATASETS) as TaipeiDataset[]).map((key) => {
    const resource = raw.resources?.[key];
    if (!resource?.url) throw new Error(`Missing Taipei ${key} resource provenance`);
    return {
      name: `${SOURCE}-${key}`,
      url: resource.url,
      version: resource.sha256 ? `sha256:${resource.sha256}` : 'provided-snapshot',
      retrieved_at: resource.retrieved_at,
      license: 'custom' as const,
      license_url: 'https://data.taipei/rule',
      attribution: '臺北大眾捷運股份有限公司 / 臺北市資料大平臺',
      notes: JSON.stringify({
        dataset_url: resource.dataset_url,
        resource_updated_at: resource.resource_updated_at,
        coverage_start: resource.coverage_start,
        coverage_end: resource.coverage_end,
        update_times: [...new Set(rows[key].map((r) => r.UpdateTime).filter(Boolean))].sort(),
        effective_dates: [...new Set(rows[key].map((r) => r.EffectiveDate).filter(Boolean))].sort()
      })
    };
  });
  const fareStation = new Map(topology.stations.map((s) => [nameKey(s.name), s.id]));
  const pairs = rows.fares.flatMap((r) => {
    const fromName = nameKey(r.起站 ?? ''),
      toName = nameKey(r.訖站 ?? '');
    const from = fareStation.get(fromName),
      to = fareStation.get(toName);
    if (!fromName || !toName || r['全票票價[金額]'] == null)
      throw new Error('Invalid Taipei fare columns');
    // The combined source includes other operators. Unmapped names leave null
    // entries for affected Taipei stations; quality reports the resulting gap.
    if (!from || !to) return [];
    return [{ from, to, price: Number(r['全票票價[金額]']) }];
  });
  if (!pairs.length) throw new Error('Taipei fare feed is empty or unrecognized');

  const network = feedNetwork(
    NETWORK_ID,
    'CN-7101',
    '臺北捷運',
    'Taipei Metro',
    '涵蓋台北捷運五條主線及新北投、小碧潭支線，包含新北市境內的台北捷運車站。提供成人單程票價、各方向首末班及官方換乘步行時間；特殊活動與臨時調整請以營運公告為準。跨新北捷運及桃園捷運的旅程需另行查詢。'
  );
  const transferRows = new Map<string, Record<string, string>>();
  for (const r of rows.transfers) {
    const name = nameKey(r.station!.replace(/^捷運/, ''));
    const stationId = fareStation.get(name) ?? fareStation.get(name.replace(/站$/, ''));
    if (!stationId) continue;
    const seconds = Number(r.Time) * 60;
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error(`Invalid Taipei transfer walk time for ${r.station}: ${r.Time}`);
    const previous = transferRows.get(stationId);
    if (previous && Number(previous.Time) !== Number(r.Time))
      throw new Error(`Conflicting Taipei transfer walk times for ${r.station}`);
    transferRows.set(stationId, r);
  }
  const transfers: TransferEncoded[] = deriveTransfers(topology.stations, topology.stops, [], {
    patterns: topology.patterns,
    routing: network.routing
  }).map((transfer) => {
    const row = transferRows.get(transfer.station_id);
    if (!row || transfer.is_out_of_station) return transfer;
    return {
      ...transfer,
      walk_time_seconds: Number(row.Time) * 60,
      source_id: `${SOURCE}-transfers/interchange/${row.sno}`,
      extras: {
        update_time: row.UpdateTime,
        effective_date: row.EffectiveDate
      }
    };
  });
  return {
    topology,
    timetables,
    transfers,
    sources,
    fares: feedFares(NETWORK_ID, topology, sources, pairs),
    network
  };
}
