import type { DrawnLinePath } from './geo.js';

export interface SharedLinePath extends DrawnLinePath {
  patternId: string;
}

/** Reuse declared corridor curves, preserving actual calls and their curve indices. */
export function resolveSharedGeometry(
  paths: readonly SharedLinePath[],
  references: ReadonlyMap<string, string>
): SharedLinePath[] {
  const byPattern = new Map<string, SharedLinePath[]>();
  for (const path of paths) {
    const group = byPattern.get(path.patternId) ?? [];
    group.push(path);
    byPattern.set(path.patternId, group);
  }
  type Resolved = { path: SharedLinePath; root: SharedLinePath; orientation: number };
  const resolved = new Map<SharedLinePath, Resolved>();
  const visiting = new Set<string>();
  const locate = (path: SharedLinePath, reference: SharedLinePath) => {
    const indices = path.stationIds.map((id) => reference.stationIds.indexOf(id));
    if (
      indices.some(
        (index, i) => index < 0 || reference.stationIds.lastIndexOf(path.stationIds[i]!) !== index
      )
    )
      return null;
    const ascending = indices.every((index, i) => i === 0 || index > indices[i - 1]!);
    const descending = indices.every((index, i) => i === 0 || index < indices[i - 1]!);
    return indices.length >= 2 && (ascending || descending)
      ? { indices, direction: ascending ? 1 : -1 }
      : null;
  };
  const resolve = (original: SharedLinePath): Resolved => {
    const cached = resolved.get(original);
    if (cached) return cached;
    if (visiting.has(original.patternId))
      throw new Error(`Shared geometry cycle at ${original.patternId}`);
    visiting.add(original.patternId);
    let result: Resolved = { path: { ...original, lane: 0 }, root: original, orientation: 1 };
    const referenceId = references.get(original.patternId);
    if (referenceId) {
      const candidates = byPattern.get(referenceId);
      if (!candidates) throw new Error(`Missing shared geometry reference ${referenceId}`);
      // Resolve first so cyclic declarations are rejected before interpreting order.
      const matches = candidates
        .map((candidate) => ({ candidate: resolve(candidate), match: locate(original, candidate) }))
        .filter((value) => value.match);
      if (matches.length !== 1)
        throw new Error(`Ambiguous or incompatible shared corridor for ${original.patternId}`);
      const { candidate, match } = matches[0]!;
      const positions = match!.indices.map((i) => candidate.path.stopIndices[i]!);
      const start = positions[0]!,
        finish = positions.at(-1)!;
      const smoothed = candidate.path.smoothed.slice(
        Math.min(start, finish),
        Math.max(start, finish) + 1
      );
      if (match!.direction < 0) smoothed.reverse();
      result = {
        path: {
          ...original,
          smoothed,
          stopIndices: positions.map((i) => Math.abs(i - start)),
          lane: 0
        },
        root: candidate.root,
        orientation: candidate.orientation * match!.direction
      };
    }
    visiting.delete(original.patternId);
    resolved.set(original, result);
    return result;
  };
  const results = paths.map(resolve);
  const families = new Map<SharedLinePath, Set<string>>();
  const sharedRoots = new Set<SharedLinePath>();
  for (const result of results) {
    if (references.has(result.path.patternId)) sharedRoots.add(result.root);
    const lines = families.get(result.root) ?? new Set<string>();
    lines.add(result.path.lineId);
    families.set(result.root, lines);
  }
  for (const result of results) {
    result.path.sharedGeometry = sharedRoots.has(result.root);
    const lines = [
      result.root.lineId,
      ...[...families.get(result.root)!].filter((id) => id !== result.root.lineId).sort()
    ];
    result.path.lane =
      (lines.indexOf(result.path.lineId) - (lines.length - 1) / 2) * result.orientation;
  }
  return results.map((result) => result.path);
}
