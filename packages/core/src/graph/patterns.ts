import type { PatternEncoded } from '../schema/index.js';

/**
 * Pattern canonicalization shared by adapters.
 *
 * Topology model (majority across CN networks — Guangzhou / Suzhou stubs):
 * - One pattern per unique alignment. A pure reverse is the same alignment and
 *   must not be a second pattern (`destination_stop_id` on timetables carries
 *   direction).
 * - A line may branch. Non-primary patterns are **spurs from the junction**
 *   (Guangzhou 3号线 北延/机场支: pattern starts at 体育西路). Only the
 *   junction stop appears on both the primary and the branch.
 * - Short-turns that are a pure subset of the primary alignment add no topology
 *   and are dropped; their first/last trains still hang off the primary pattern
 *   via `destination_stop_id`.
 *
 * Shanghai-style through-running branches (primary + branch share most of the
 * trunk) are the minority and are stub-ified here so the invariant
 * **"only the junction appears in multiple patterns"** holds.
 */

function reverseSig(stopIds: readonly string[]): string {
  return [...stopIds].reverse().join('|');
}

function sig(stopIds: readonly string[]): string {
  return stopIds.join('|');
}

export interface CanonicalizePatternsResult {
  patterns: PatternEncoded[];
  /** Pattern ids removed (reverse duplicates, subsets, empty spurs). */
  droppedPatternIds: string[];
  /** Pattern ids whose stop_ids were trimmed to a junction spur. */
  stubbedPatternIds: string[];
}

/**
 * Drop reverse duplicates, pick one primary per line (longest alignment),
 * stamp `junction_stop_id`, stub-ify through-running branches to the spur,
 * and drop subset short-turns.
 */
export function canonicalizePatterns(
  patterns: readonly PatternEncoded[]
): CanonicalizePatternsResult {
  const droppedPatternIds: string[] = [];
  const stubbedPatternIds: string[] = [];

  // 1) Collapse reverse pairs (keep the first occurrence).
  const seen = new Set<string>();
  const collapsed: PatternEncoded[] = [];
  for (const p of patterns) {
    const s = sig(p.stop_ids);
    const r = reverseSig(p.stop_ids);
    if (seen.has(s) || seen.has(r)) {
      droppedPatternIds.push(p.id);
      continue;
    }
    seen.add(s);
    collapsed.push(p);
  }

  // 2) Per line: primary = longest; classify / stub-ify / drop the rest.
  const byLine = new Map<string, PatternEncoded[]>();
  for (const p of collapsed) {
    const list = byLine.get(p.line_id) ?? [];
    list.push(p);
    byLine.set(p.line_id, list);
  }

  const out: PatternEncoded[] = [];
  for (const [, linePatterns] of byLine) {
    const sorted = [...linePatterns].sort((a, b) => b.stop_ids.length - a.stop_ids.length);
    // Prefer the source's primary (the operator's main alignment). A longer
    // through-running branch must not steal primary — it gets stub-ified below.
    const primary = sorted.find((p) => p.is_primary) ?? sorted[0]!;
    const trunk = new Set(primary.stop_ids);
    out.push({
      ...primary,
      is_primary: true,
      junction_stop_id: undefined,
      extras: { ...primary.extras, pattern_role: 'direction' }
    });

    for (const p of sorted) {
      if (p.id === primary.id) continue;
      const shared = p.stop_ids.filter((id) => trunk.has(id));
      // Subset short-turn: every stop already on the primary — no unique topology.
      if (shared.length === p.stop_ids.length) {
        droppedPatternIds.push(p.id);
        continue;
      }
      // Disjoint spur / second alignment: keep as-is (no junction onto primary).
      if (shared.length === 0) {
        out.push({
          ...p,
          is_primary: false,
          junction_stop_id: undefined,
          extras: { ...p.extras, pattern_role: 'branch' }
        });
        continue;
      }

      // Through-running or stub branch: reduce to junction → unique spur.
      const junction =
        p.junction_stop_id && trunk.has(p.junction_stop_id)
          ? p.junction_stop_id
          : findJunctionStopId(p.stop_ids, trunk);
      if (!junction) {
        // Cannot locate a divergence — keep but only if it already is a stub.
        if (shared.length === 1 && p.junction_stop_id) {
          out.push({ ...p, is_primary: false, extras: { ...p.extras, pattern_role: 'branch' } });
          continue;
        }
        droppedPatternIds.push(p.id);
        continue;
      }

      const jIdx = p.stop_ids.indexOf(junction);
      // Unique neighbours of the junction that are not on the primary trunk.
      const spurIds = extractSpur(p.stop_ids, junction, trunk);
      if (spurIds.length < 2) {
        droppedPatternIds.push(p.id);
        continue;
      }
      const trimmed = spurIds.length !== p.stop_ids.length;
      const stubId = trimmed
        ? `${p.line_id}-pattern-${slugTail(spurIds[0]!)}-to-${slugTail(spurIds[spurIds.length - 1]!)}`
        : p.id;
      if (trimmed) stubbedPatternIds.push(p.id);
      out.push({
        ...p,
        id: stubId,
        stop_ids: spurIds,
        origin_stop_id: spurIds[0]!,
        terminal_stop_id: spurIds[spurIds.length - 1]!,
        is_primary: false,
        junction_stop_id: junction,
        extras: {
          ...p.extras,
          pattern_role: 'branch',
          stub_of: p.id,
          stubbed_from_n: p.stop_ids.length,
          junction_index_in_source: jIdx
        }
      });
    }
  }

  // 3) Stub-ification can collapse two through-running alignments onto the same
  //    spur (or its reverse). Drop those leftovers.
  const finalSeen = new Set<string>();
  const final: PatternEncoded[] = [];
  for (const p of out) {
    const s = sig(p.stop_ids);
    const r = reverseSig(p.stop_ids);
    if (finalSeen.has(s) || finalSeen.has(r)) {
      droppedPatternIds.push(p.id);
      continue;
    }
    finalSeen.add(s);
    final.push(p);
  }

  return { patterns: final, droppedPatternIds, stubbedPatternIds };
}

function slugTail(stopId: string): string {
  return stopId.replace(/^cn-[^-]+-/, '');
}

/**
 * Junction stop where the alignment leaves the primary trunk (first trunk stop
 * that has a non-trunk neighbour on this pattern).
 */
export function findJunctionStopId(
  patternStopIds: readonly string[],
  trunkStopIds: ReadonlySet<string>
): string | undefined {
  for (let i = 0; i < patternStopIds.length; i++) {
    const id = patternStopIds[i]!;
    if (!trunkStopIds.has(id)) continue;
    const prev = i > 0 ? patternStopIds[i - 1] : undefined;
    const next = i + 1 < patternStopIds.length ? patternStopIds[i + 1] : undefined;
    if ((prev && !trunkStopIds.has(prev)) || (next && !trunkStopIds.has(next))) {
      return id;
    }
  }
  return undefined;
}

/**
 * Spur from the junction: junction + the run of non-trunk stops, oriented so
 * the spur extends away from the trunk. When the source alignment runs
 * trunk→junction→spur the result is `[junction, ...spur]`. When it runs
 * spur→junction→trunk (e.g. 花桥→迪士尼), the result is reversed to
 * `[junction, ...spur]`.
 */
function extractSpur(
  stopIds: readonly string[],
  junction: string,
  trunk: ReadonlySet<string>
): string[] {
  const jIdx = stopIds.indexOf(junction);
  if (jIdx < 0) return [];
  const before: string[] = [];
  for (let i = jIdx - 1; i >= 0; i--) {
    const id = stopIds[i]!;
    if (trunk.has(id)) break;
    before.unshift(id);
  }
  const after: string[] = [];
  for (let i = jIdx + 1; i < stopIds.length; i++) {
    const id = stopIds[i]!;
    if (trunk.has(id)) break;
    after.push(id);
  }
  // Orient toward the longer (or only) spur side; if both sides have non-trunk
  // stops the alignment is not a simple Y — prefer the side that reaches a
  // non-trunk terminal.
  const startIsTrunk = trunk.has(stopIds[0]!);
  const endIsTrunk = trunk.has(stopIds[stopIds.length - 1]!);
  // `before` is collected by walking backward with unshift → far-end first.
  // Orient the spur as junction → … → far end.
  if (startIsTrunk && !endIsTrunk) return [junction, ...after];
  if (!startIsTrunk && endIsTrunk) return [junction, ...before.reverse()];
  // Both ends non-trunk (unusual): pick the longer spur.
  if (after.length >= before.length) return [junction, ...after];
  return [junction, ...before.reverse()];
}
