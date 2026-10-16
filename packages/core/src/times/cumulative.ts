export interface JourneyTime {
  from: string;
  to: string;
  seconds: number;
}

/** Difference terminal-anchored whole journeys, never sum rounded adjacent quotes.
 * Each direction has its own anchor; rounded intermediate OD quotes need not
 * match differences of independently rounded terminal quotes.
 */
export function deriveCumulativeTimes(
  order: readonly string[],
  journeys: readonly JourneyTime[]
): JourneyTime[] {
  if (order.length < 2 || new Set(order).size !== order.length)
    throw new Error('Invalid cumulative journey stop order');
  const values = new Map<string, number>();
  const key = (a: string, b: string) => JSON.stringify([a, b]);
  for (const q of journeys) {
    if (!order.includes(q.from) || !order.includes(q.to) || q.from === q.to)
      throw new Error(`Unknown/self journey ${q.from}/${q.to}`);
    if (!Number.isFinite(q.seconds) || q.seconds <= 0)
      throw new Error(`Invalid journey time ${q.from}/${q.to}`);
    const old = values.get(key(q.from, q.to));
    if (old != null && old !== q.seconds) throw new Error('Conflicting journey times');
    values.set(key(q.from, q.to), q.seconds);
  }
  const elapsed = (anchor: string, stop: string) => {
    if (anchor === stop) return 0;
    const value = values.get(key(anchor, stop));
    if (value == null) throw new Error(`Missing cumulative journey ${anchor}/${stop}`);
    return value;
  };
  const edges: JourneyTime[] = [];
  for (const stops of [order, [...order].reverse()]) {
    const anchor = stops[0]!;
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1]!;
      const to = stops[i]!;
      const seconds = elapsed(anchor, to) - elapsed(anchor, from);
      if (seconds <= 0) throw new Error(`Non-monotonic cumulative journey ${from}/${to}`);
      edges.push({ from, to, seconds });
    }
  }
  return edges;
}
