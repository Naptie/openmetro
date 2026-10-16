import { expect, test } from 'bun:test';
import { parseFareResponse } from '../src/fares.js';

const quote = (price: string) => ({
  info: { success: true },
  data: [
    {
      price,
      startStation: { id: 1 },
      endStation: { id: 15 }
    }
  ]
});

test('accepts only a numeric fare for the exact requested official station ids', () => {
  expect(parseFareResponse(quote('8'), 1, 15)).toBe(8);
  expect(() => parseFareResponse(quote('8元'), 1, 15)).toThrow();
  expect(() => parseFareResponse(quote('0'), 1, 15)).toThrow();
  expect(() => parseFareResponse(quote('8'), 1, 14)).toThrow();
  expect(() => parseFareResponse({ info: { success: false }, data: [] }, 1, 15)).toThrow();
  expect(() => parseFareResponse({ info: { success: true }, data: [] }, 1, 15)).toThrow();
});
