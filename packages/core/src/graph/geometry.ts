interface GeometryPattern {
  id: string;
  line_id: string;
  is_primary: boolean;
  stop_ids: readonly string[];
  geometry_reference_pattern_id?: string;
}

/** A shared display corridor must preserve the order of actual physical stations. */
export function assertPatternGeometryReferences(
  patterns: readonly GeometryPattern[],
  stops: readonly { id: string; station_id: string }[],
  lines: readonly { id: string; loop?: boolean }[]
): void {
  const byId = new Map(patterns.map((p) => [p.id, p]));
  const stationByStop = new Map(stops.map((s) => [s.id, s.station_id]));
  const lineById = new Map(lines.map((line) => [line.id, line]));
  for (const pattern of patterns) {
    if (!pattern.geometry_reference_pattern_id) continue;
    const seen = new Set([pattern.id]);
    let current = pattern;
    while (current.geometry_reference_pattern_id) {
      const id = current.geometry_reference_pattern_id;
      if (seen.has(id)) throw new Error(`Pattern geometry reference cycle at ${id}`);
      seen.add(id);
      const next = byId.get(id);
      if (!next) throw new Error(`Unknown pattern geometry reference ${id}`);
      current = next;
    }
    const reference = byId.get(pattern.geometry_reference_pattern_id)!;
    // Branches are trimmed for display and loops duplicate their closing point.
    // Only full, linear primary paths form unambiguous reusable corridors.
    if (!reference.is_primary)
      throw new Error(`Pattern ${pattern.id} geometry reference must be a primary alignment`);
    if (!lineById.has(reference.line_id) || lineById.get(reference.line_id)!.loop)
      throw new Error(`Pattern ${pattern.id} geometry reference must belong to a linear line`);
    const sourceStations = reference.stop_ids.map((id) => stationByStop.get(id));
    const indices = pattern.stop_ids.map((id) => {
      const station = stationByStop.get(id),
        index = sourceStations.indexOf(station);
      if (!station || index < 0 || sourceStations.lastIndexOf(station) !== index)
        throw new Error(
          `Pattern ${pattern.id} has an absent or ambiguous geometry reference station`
        );
      return index;
    });
    const forward = indices.every((index, i) => i === 0 || index > indices[i - 1]!);
    const reverse = indices.every((index, i) => i === 0 || index < indices[i - 1]!);
    if (indices.length < 2 || (!forward && !reverse))
      throw new Error(`Pattern ${pattern.id} geometry reference station order disagrees`);
  }
}
