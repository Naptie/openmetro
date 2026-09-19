import { join } from 'node:path';
import {
  deriveTransfers,
  fillCoordinates,
  type KnownLocation,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';
import { fetchGuangzhouSources } from './fetch.js';
import { normalize } from './normalize.js';

/**
 * Hand-verified coordinates for stations the automatic cascade resolves
 * wrongly. OSM-verified GCJ-02 values are fed into `fillCoordinates` via
 * `knownLocations` so the correct source is selected and its provenance is
 * recorded in `extras.location_source`.
 *
 * The （有轨） tram stops below share their base name with a metro station;
 * AMap's subway dataset wins the cascade before the official coords are
 * consulted (the matcher strips the parenthetical), which pins them to the
 * metro station. Values come from the official GZMTR station details feed
 * (`app-map/station/getByNameOrCode`), already in GCJ-02.
 */
export const KNOWN_LOCATIONS: KnownLocation[] = [
  { name: '萝峰', location: { lon: 113.512584, lat: 23.178897, crs: 'gcj02' }, source: 'osm' },
  {
    name: '香雪大道东',
    location: { lon: 113.518633, lat: 23.180396, crs: 'gcj02' },
    source: 'osm'
  },
  {
    name: '开源大道东',
    location: { lon: 113.533111, lat: 23.167857, crs: 'gcj02' },
    source: 'osm'
  },
  {
    name: '水西（有轨）',
    location: { lon: 113.485015, lat: 23.197026, crs: 'gcj02' },
    source: 'official'
  },
  {
    name: '广州塔（有轨）',
    location: { lon: 113.321544, lat: 23.107112, crs: 'gcj02' },
    source: 'official'
  },
  {
    name: '万胜围（有轨）',
    location: { lon: 113.385654, lat: 23.104339, crs: 'gcj02' },
    source: 'official'
  },
  {
    name: '林岳东（有轨）',
    location: { lon: 113.249703, lat: 22.993753, crs: 'gcj02' },
    source: 'official'
  }
];

/**
 * City-specific station corrections, applied after `fillCoordinates`.
 *
 * AMap's subway dataset has the coordinates of 孝德东 and 罗村 (Foshan Line 3 /
 * F3) swapped; the official station order and OSM both place 孝德东 east of
 * 罗村. We restore the correct pairing and mark both as hand-verified.
 */
export const transformStations: TransformStations = (stations) => {
  const byName = new Map<string | undefined, (typeof stations)[number]>();
  for (const s of stations) byName.set(s.names?.zh, s);
  const xiaode = byName.get('孝德东');
  const luocun = byName.get('罗村');
  const xiaodeLoc = xiaode?.location;
  const luocunLoc = luocun?.location;
  if (!xiaode || !luocun || !xiaodeLoc || !luocunLoc) return stations;
  return stations.map((s) => {
    if (s === xiaode) {
      return {
        ...s,
        location: luocunLoc,
        extras: { ...(s.extras ?? {}), location_source: 'known' }
      };
    }
    if (s === luocun) {
      return {
        ...s,
        location: xiaodeLoc,
        extras: { ...(s.extras ?? {}), location_source: 'known' }
      };
    }
    return s;
  });
};

export interface GuangzhouNormalizeOptions {
  root?: string;
}

export async function runGuangzhouNormalize(opts: GuangzhouNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-gz');

  const { linestation, stationDetails, servicetimes } = await fetchGuangzhouSources();
  const canonical = normalize({ linestation, stationDetails, servicetimes });

  let geocoded = 0;
  let subwayMatched = 0;
  let overpassMatched = 0;
  let officialMatched = 0;
  const stations = transformStations(
    await fillCoordinates(canonical.stations, {
      city: '广州',
      extraCities: ['佛山', '东莞', '惠州', '肇庆'],
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      knownLocations: KNOWN_LOCATIONS,
      segments: canonical.segments.map((s) => ({
        from_station_id: s.from_station_id,
        to_station_id: s.to_station_id,
        line_id: s.line_id,
        travel_time_seconds: s.travel_time_seconds,
        travel_time_source: s.travel_time_source
      })),
      speedValidate: true,
      onSubwayMatch: () => subwayMatched++,
      onOfficialMatch: () => officialMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    }),
    { network: canonical.network.id, city: '广州', extraCities: ['佛山', '东莞', '惠州', '肇庆'] }
  );

  const transfers = deriveTransfers(stations, canonical.stops, [], {
    patterns: canonical.patterns,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    routing: canonical.network.routing,
    crossStation: true
  });

  await writeCanonical(outDir, 'cn-gz', {
    network: canonical.network,
    lines: canonical.lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments: canonical.segments,
    transfers,
    timetables: canonical.timetables
  });

  console.log('lines:', canonical.lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via subway:', subwayMatched);
  console.log('  via official:', officialMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
  console.log('stops:', canonical.stops.length);
  console.log('segments:', canonical.segments.length);
  console.log('transfers:', transfers.length);
  console.log(
    'transfers cross-station:',
    transfers.filter((t) => String(t.source_id ?? '').startsWith('auto-xfer/v1')).length
  );
  console.log(
    'segments derived:',
    canonical.segments.filter((s) => s.travel_time_source === 'last_train').length
  );
  console.log('timetables:', canonical.timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runGuangzhouNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
