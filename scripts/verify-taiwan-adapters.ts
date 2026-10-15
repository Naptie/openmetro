/** Live acceptance: fresh scratch cache, no canonical writes.
 * bun run scripts/verify-taiwan-adapters.ts [--fares]
 * The optional fares flag harvests all KRTC within-system pairs from scratch.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchKaohsiung } from '../packages/adapters/cn-kaohsiung/src/fetch.js';
import { normalizeKaohsiung } from '../packages/adapters/cn-kaohsiung/src/normalize.js';
import { fetchTaichung } from '../packages/adapters/cn-taichung/src/fetch.js';
import { normalizeTaichung } from '../packages/adapters/cn-taichung/src/normalize.js';
import {
  assertSimpleServiceCoverage,
  buildStopGraph,
  planRoute
} from '../packages/core/src/index.js';

const scratch = await mkdtemp(join(tmpdir(), 'openmetro-taiwan-cold-'));
console.log(`Cold cache (initially empty): ${scratch}`);
const fullFares = process.argv.includes('--fares');
const [tcInput, khInput] = await Promise.all([
  fetchTaichung(),
  fetchKaohsiung({ fares: fullFares, cacheDir: scratch })
]);
const tc = normalizeTaichung(tcInput);
const kh = normalizeKaohsiung(khInput);
await writeFile(join(scratch, 'taichung-sources.json'), JSON.stringify(tcInput));

// Partial response mutations must fail at normalization, before any write.
const tcBroken = structuredClone(tcInput);
delete tcBroken.serviceStations[1]!.LastWeekdayTimeU;
assert.throws(() => normalizeTaichung(tcBroken), /service/);
const khBroken = structuredClone(khInput);
khBroken.timetables.find((t) => t.code.startsWith('C'))!.rows.pop();
assert.throws(() => normalizeKaohsiung(khBroken), /direction/);
// Also check already-normalized payloads, independently of parser tests.
for (const data of [tc, kh]) {
  for (const pattern of data.patterns) {
    const loop = data.lines.find((l) => l.id === pattern.line_id)!.loop ?? false;
    const rows = data.timetables.filter((t) => t.line_id === pattern.line_id);
    assertSimpleServiceCoverage(pattern.stop_ids, loop, rows);
    assert.throws(
      () => assertSimpleServiceCoverage(pattern.stop_ids, loop, rows.slice(1)),
      /direction/
    );
  }
}

const report: Record<string, unknown> = { scratch, fullFares, missingDirectionRejected: true };
for (const data of [tc, kh]) {
  const graph = buildStopGraph(
    data.network.id,
    data.stops,
    data.segments,
    data.transfers,
    data.network.routing!
  );
  const routes = data.patterns
    .filter((p) => !data.lines.find((l) => l.id === p.line_id)?.loop)
    .flatMap((p) => {
      const a = data.stops.find((s) => s.id === p.stop_ids[0])!.station_id;
      const b = data.stops.find((s) => s.id === p.stop_ids.at(-1))!.station_id;
      return [
        [a, b],
        [b, a]
      ].map(([from, to]) => ({
        from,
        to,
        seconds: planRoute(graph, data.stops, from!, to!)!.total_seconds
      }));
    });
  report[data.network.id] = {
    stations: data.stations.length,
    stops: data.stops.length,
    timetables: data.timetables.length,
    segments: data.segments.length,
    routes
  };
}
// All whole-journey comparisons (not only terminal pairs) happen in the
// normalizers: 306 Taichung rows and every same-line KRTC quote, <=60s error.
let farePairs = 0;
if (fullFares) {
  for (let i = 0; i < khInput.stations.length; i++)
    for (let j = i + 1; j < khInput.stations.length; j++) {
      const a = khInput.stations[i]!;
      const b = khInput.stations[j]!;
      const ai = kh.fares.station_ids.indexOf(`cn-kaohsiung-${a.key.toLowerCase()}`);
      const bi = kh.fares.station_ids.indexOf(`cn-kaohsiung-${b.key.toLowerCase()}`);
      const price = kh.fares.fares[ai]![bi];
      if (a.section === b.section) {
        assert(price != null && price > 0);
        farePairs++;
      } else assert.equal(price, null);
    }
}
report.kaohsiungFarePairs = farePairs;
report.c18 = khInput.stations.find((s) => s.codes.includes('C18'));
report.taichungJourneyChecks = tcInput.journeys.length;
report.kaohsiungQuotes = khInput.quotes.length;
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
