import { join } from 'node:path';
import {
  enrichLineNamesFromWikidata,
  fillCoordinates,
  type LineEncoded,
  type TransformStations,
  writeCanonical
} from '@openmetro/core';
import { fetchShanghaiSources } from './fetch.js';
import { normalize, type ShStationInfo } from './normalize.js';

/** Shanghai has no city-specific station corrections yet. */
export const transformStations: TransformStations = (stations) => stations;

export interface ShanghaiNormalizeOptions {
  root?: string;
}

export async function runShanghaiNormalize(opts: ShanghaiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-sh');

  const {
    nameToCodes,
    lines: linesMeta,
    lineSequences,
    stations: stationRecords,
    fltimeRows,
    lineNotes
  } = await fetchShanghaiSources();

  const stationsByCode: Record<string, ShStationInfo[]> = {};
  for (const [code, infos] of Object.entries(stationRecords as Record<string, ShStationInfo[]>)) {
    stationsByCode[code] = infos;
  }

  const canonical = normalize({
    lineSequences,
    lines: linesMeta,
    stations: stationsByCode,
    fltimeRows,
    lineNotes,
    nameToCodes
  });

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.names.zh
  });

  // Station location is left unset here; fillCoordinates places them from
  // AMap first, then official stationInfo GCJ-02, then Overpass/Photon.
  let subwayMatched = 0;
  let officialMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  const stations = transformStations(
    await fillCoordinates(canonical.stations, {
      city: '上海',
      stops: canonical.stops,
      lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
      officialLocations: canonical.officialLocations,
      onSubwayMatch: () => subwayMatched++,
      onOfficialMatch: () => officialMatched++,
      onOverpassMatch: () => overpassMatched++,
      onGeocode: () => geocoded++
    }),
    { network: canonical.network.id, city: '上海' }
  );

  await writeCanonical(outDir, 'cn-sh', {
    network: canonical.network,
    lines,
    stations: stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments: canonical.segments,
    transfers: canonical.transfers,
    timetables: canonical.timetables
  });

  console.log('lines:', lines.length);
  console.log('stations:', stations.length);
  console.log('with coords:', stations.filter((s) => s.location).length);
  console.log('  via subway:', subwayMatched);
  console.log('  via official:', officialMatched);
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
  console.log('stops:', canonical.stops.length);
  console.log('segments:', canonical.segments.length);
  console.log('timetables:', canonical.timetables.length);
  console.log(
    'segments with derived time:',
    canonical.segments.filter((s) => s.travel_time_source === 'last_train').length
  );
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runShanghaiNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
