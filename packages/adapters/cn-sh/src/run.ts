import { join } from "node:path";
import { fillCoordinates, writeCanonical } from "@openmetro/core";
import { fetchShanghaiSources } from "./fetch.js";
import { normalize, type ShStationInfo } from "./normalize.js";

export interface ShanghaiNormalizeOptions {
  root?: string;
}

export async function runShanghaiNormalize(opts: ShanghaiNormalizeOptions = {}): Promise<void> {
  const root = opts.root ?? process.env.OPENMETRO_ROOT ?? process.cwd();
  const outDir = join(root, "data/cn-sh");

  const {
    nameToCode,
    lines: linesMeta,
    lineSequences,
    stations: stationRecords,
    fltimeRows,
    lineNotes,
  } = await fetchShanghaiSources();

  const stationsByName: Record<string, ShStationInfo[]> = {};
  for (const infos of Object.values(stationRecords as Record<string, ShStationInfo[]>)) {
    for (const info of infos) {
      (stationsByName[info.name_cn] ??= []).push(info);
    }
  }

  const canonical = normalize({
    lineSequences,
    lines: linesMeta,
    stations: stationsByName,
    fltimeRows,
    lineNotes,
    nameToCode,
  });

  // Strip raw GPS coords from shmetro API; the AMap subway dataset provides proper GCJ-02.
  const stationsNoCoords = canonical.stations.map((s) => ({ ...s, location: undefined }));

  let subwayMatched = 0;
  let overpassMatched = 0;
  let geocoded = 0;
  const stations = await fillCoordinates(stationsNoCoords, {
    city: "上海",
    stops: canonical.stops,
    lines: canonical.lines.map((l) => ({ id: l.id, mode: l.mode })),
    onSubwayMatch: () => subwayMatched++,
    onOverpassMatch: () => overpassMatched++,
    onGeocode: () => geocoded++,
  });

  await writeCanonical(outDir, "cn-sh", {
    network: canonical.network,
    lines: canonical.lines,
    stations: stations,
    stops: canonical.stops,
    patterns: canonical.patterns,
    segments: canonical.segments,
    transfers: canonical.transfers,
    timetables: canonical.timetables,
  });

  console.log("lines:", canonical.lines.length);
  console.log("stations:", stations.length);
  console.log("with coords:", stations.filter((s) => s.location).length);
  console.log("  via subway:", subwayMatched);
  console.log("  via overpass:", overpassMatched);
  console.log("  via tencent:", geocoded);
  console.log("stops:", canonical.stops.length);
  console.log("segments:", canonical.segments.length);
  console.log("timetables:", canonical.timetables.length);
  console.log(
    "segments with derived time:",
    canonical.segments.filter((s) => s.travel_time_source === "last_train").length,
  );
}

const isDirect = process.argv[1]?.includes("run.ts");
if (isDirect) {
  runShanghaiNormalize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
