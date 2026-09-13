import { join } from 'node:path';
import { fillCoordinates, writeCanonical } from '@openmetro/core';
import { fetchGuangzhouSources } from './fetch.js';
import { normalize } from './normalize.js';

type Loc = { lon: number; lat: number; crs: string };
type LocatableStation = { names?: { zh?: string }; location?: Loc };

/**
 * Correct known upstream coordinate errors. AMap's subway dataset has the
 * coordinates of 孝德东 and 罗村 (Foshan Line 3 / F3) swapped; the official
 * station order and OSM both place 孝德东 east of 罗村.
 */
function fixKnownCoordinateErrors<T extends LocatableStation>(stations: T[]): T[] {
  const byName = new Map<string | undefined, T>();
  for (const s of stations) byName.set(s.names?.zh, s);
  const xiaode = byName.get('孝德东');
  const luocun = byName.get('罗村');
  const xiaodeLoc = xiaode?.location;
  const luocunLoc = luocun?.location;
  if (!xiaode || !luocun || !xiaodeLoc || !luocunLoc) return stations;
  return stations.map((s) => {
    if (s === xiaode) return { ...s, location: luocunLoc };
    if (s === luocun) return { ...s, location: xiaodeLoc };
    return s;
  });
}

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
  const stations = fixKnownCoordinateErrors(
    await fillCoordinates(canonical.stations, {
      city: '广州',
      extraCities: ['佛山', '东莞', '惠州', '肇庆'],
      stops: canonical.stops,
      lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      onSubwayMatch: () => subwayMatched++,
      onOfficialMatch: () => officialMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    })
  );

  await writeCanonical(outDir, 'cn-gz', {
    network: canonical.network,
    lines: canonical.lines,
    stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments: canonical.segments,
    transfers: canonical.transfers,
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
