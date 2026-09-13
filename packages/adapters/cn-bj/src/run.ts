import { join } from 'node:path';
import {
  enrichLineNamesFromWikidata,
  fillCoordinates,
  type LineEncoded,
  writeCanonical
} from '@openmetro/core';
import { fetchBeijingSources } from './fetch.js';
import { normalize } from './normalize.js';

export interface BeijingNormalizeOptions {
  /** Repository root containing `data/cn-bj`. */
  root?: string;
}

export async function runBeijingNormalize(opts: BeijingNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, 'data/cn-bj');

  const sources = await fetchBeijingSources();
  const canonical = normalize({
    beijingXml: sources.beijingXml,
    stationsXml: sources.stationsXml,
    apiStationsJson: sources.apiStations,
    timeinfos: sources.timeinfos,
    interchangeXml: sources.interchangeXml
  });

  const lines = await enrichLineNamesFromWikidata(canonical.lines, {
    getEnglishLookupLabel: (line: LineEncoded) => line.name
  });

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  const stations = await fillCoordinates(canonical.stations, {
    city: '北京',
    stops: canonical.stops,
    lines: lines.map((l) => ({ id: l.id, mode: l.mode })),
    onSubwayMatch: () => subwayMatched++,
    onOverpassMatch: () => overpassMatched++,
    onGeocode: () => geocoded++
  });

  await writeCanonical(outDir, 'cn-bj', {
    network: canonical.network,
    lines,
    stations,
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
  console.log('  via overpass:', overpassMatched);
  console.log('  via tencent:', geocoded);
  console.log('stops:', canonical.stops.length);
  console.log('segments:', canonical.segments.length);
  console.log('transfers:', canonical.transfers.length);
  console.log('timetables:', canonical.timetables.length);
}

const isDirect = process.argv[1]?.includes('run.ts');
if (isDirect) {
  runBeijingNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
