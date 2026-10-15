import { expect, test } from 'bun:test';
import * as geocode from '../src/geocode.js';

const station = {
  zh: '鼓山',
  en: 'Gushan',
  location: { lon: 120.2809263, lat: 22.641978, crs: 'wgs84' as const }
};
const rail = {
  id: 8057987302,
  type: 'node',
  lon: 120.2810929,
  lat: 22.6420358,
  tags: {
    name: '輕軌鼓山站',
    'name:en': 'Gushan',
    railway: 'station',
    station: 'light_rail',
    ref: 'C18',
    network: '高雄捷運'
  }
};

test('C18 accepts the light rail station despite a prefixed name and rejects same-name TRA', () => {
  expect(geocode.matchesRailIdentity(rail, station, ['C18'], true)).toBe(true);
  expect(
    geocode.matchesRailIdentity(
      {
        ...rail,
        tags: { ...rail.tags, name: '鼓山', station: 'train', ref: '4380', network: '臺鐵' }
      },
      station,
      ['C18'],
      true
    )
  ).toBe(false);
});

test('mode, official code and city bounds are all required', () => {
  for (const changed of [
    { ...rail, lat: 25 },
    { ...rail, tags: { ...rail.tags, ref: 'C19' } },
    { ...rail, tags: { ...rail.tags, station: 'subway' } },
    { ...rail, tags: { ...rail.tags, network: '臺鐵' } }
  ])
    expect(geocode.matchesRailIdentity(changed, station, ['C18'], true)).toBe(false);
});
