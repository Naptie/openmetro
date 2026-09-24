/**
 * One-shot: collapse reverse-duplicate patterns and stub-ify through-running
 * branches on every network's on-disk `patterns.json`, then re-bind
 * `timetables.json` pattern_ids so stop+destination stay on one pattern.
 *
 *   bun run scripts/canonicalize-patterns.ts
 *
 * Long-term the same `canonicalizePatterns` call belongs in each adapter's
 * normalize; this script brings existing datasets in line with the model.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizePatterns } from '../packages/core/src/graph/patterns.js';
import type { PatternEncoded, TimetableEncoded } from '../packages/core/src/schema/index.js';

const ROOT = process.env.OPENMETRO_ROOT || process.cwd();
const DATA = join(ROOT, 'data');

async function main(): Promise<void> {
  const nets = (await readdir(DATA, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith('cn-'))
    .map((e) => e.name)
    .sort();

  for (const net of nets) {
    const dir = join(DATA, net);
    const patternsPath = join(dir, 'patterns.json');
    const timetablesPath = join(dir, 'timetables.json');
    let patternsDoc: { records: PatternEncoded[] };
    let timetablesDoc: { records: TimetableEncoded[] };
    try {
      patternsDoc = JSON.parse(await readFile(patternsPath, 'utf-8'));
      timetablesDoc = JSON.parse(await readFile(timetablesPath, 'utf-8'));
    } catch {
      console.log(`${net}: skip (missing files)`);
      continue;
    }

    const before = patternsDoc.records.length;
    const { patterns, droppedPatternIds, stubbedPatternIds } = canonicalizePatterns(
      patternsDoc.records
    );
    const after = patterns.length;

    // Re-bind timetables: prefer a pattern containing both stop and destination.
    const byLine = new Map<string, PatternEncoded[]>();
    for (const p of patterns) {
      const list = byLine.get(p.line_id) ?? [];
      list.push(p);
      byLine.set(p.line_id, list);
    }
    const keptTt: TimetableEncoded[] = [];
    let rebound = 0;
    for (const t of timetablesDoc.records) {
      const cands = byLine.get(t.line_id) ?? [];
      const dest = t.destination_stop_id;
      const fit =
        cands.find(
          (p) => p.stop_ids.includes(t.stop_id) && dest != null && p.stop_ids.includes(dest)
        ) ?? cands.find((p) => p.stop_ids.includes(t.stop_id));
      // Keep official times even when dest sits on another pattern of the line
      // (through-running after stub-ification) — direction is the destination.
      if (!fit) continue;
      if (fit.id !== t.pattern_id) rebound++;
      keptTt.push({ ...t, pattern_id: fit.id });
    }

    patternsDoc.records = patterns.sort((a, b) => a.id.localeCompare(b.id));
    timetablesDoc.records = keptTt.sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(patternsPath, `${JSON.stringify(patternsDoc, null, 2)}\n`, 'utf-8');
    await writeFile(timetablesPath, `${JSON.stringify(timetablesDoc, null, 2)}\n`, 'utf-8');
    console.log(
      `${net}: patterns ${before}→${after} (dropped ${droppedPatternIds.length}, stubbed ${stubbedPatternIds.length}); timetables ${rebound} rebound`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
