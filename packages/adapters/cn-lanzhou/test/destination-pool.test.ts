import { expect, test } from 'bun:test';
import type { BaiduStationRef } from '../../core/src/index.js';
import { destinationPool } from '../src/timetables.ts';

const refs: BaiduStationRef[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({
  name,
  lon: 103.66,
  lat: 36.09
}));

test('the destination pool stays inside the direction of travel', () => {
  // Toward the last stop of the line.
  const down = destinationPool(refs, 2, 'down').map((r) => r.name);
  expect(down[0]).toBe('D'); // nearest first
  expect(down).toContain('F'); // the far terminus is the farthest candidate
  expect(down).not.toContain('A');
  expect(down).not.toContain('B');
  // Every station in that direction is a candidate: the planner's routing
  // holes are not contiguous, so a narrow pool would miss stations.
  expect(down).toEqual(['D', 'E', 'F']);

  // Toward the first stop of the line.
  const up = destinationPool(refs, 2, 'up').map((r) => r.name);
  expect(up[0]).toBe('B');
  expect(up).toContain('A');
  expect(up).not.toContain('E');
  expect(up).toEqual(['B', 'A']);
});

test('the pool degrades gracefully at the ends of the line', () => {
  const first = destinationPool(refs, 0, 'down').map((r) => r.name);
  expect(first[0]).toBe('B');
  expect(first).toContain('F');
  expect(first).not.toContain('A');

  const last = destinationPool(refs, refs.length - 1, 'up').map((r) => r.name);
  expect(last[0]).toBe('E');
  expect(last).toContain('A');
  expect(last).not.toContain('F');
});
