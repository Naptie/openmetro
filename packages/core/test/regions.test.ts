import { describe, expect, test } from 'bun:test';
import { parseRegionsCsv, placeholderCity, resolveCity } from '../src/regions/index.js';

const CSV = [
  'id,parentId,level,name,population,area,location',
  'CN,,country,"{""en"":""China"",""zh"":""中国""}",,,',
  'CN-32,CN,province,"{""en"":""Jiangsu"",""zh"":""江苏省""}",84748016,98285,',
  'CN-3205,CN-32,city,"{""en"":""Suzhou"",""zh"":""苏州市""}",12748262,8657.32,"{""type"":""Point"",""coordinates"":[120.619444444,31.3]}"',
  'CN-81,CN,province,"{""en"":""Hong Kong Special Administrative Region"",""zh"":""香港特别行政区""}",7413070,2755.03,"{""type"":""Point"",""coordinates"":[114.158611111,22.278333333]}"',
  'CN-320501,CN-3205,county,"{""en"":""Foo"",""zh"":""甲区""}",,,'
].join('\n');

describe('parseRegionsCsv', () => {
  test('keeps country/province/city and drops county', () => {
    const index = parseRegionsCsv(CSV);
    expect(index.has('CN-3205')).toBe(true);
    expect(index.has('CN-81')).toBe(true);
    expect(index.has('CN-320501')).toBe(false);
    expect(index.get('CN-3205')?.name.zh).toBe('苏州市');
  });
});

describe('resolveCity', () => {
  test('fills City from the region record and walks country ancestor', () => {
    const index = parseRegionsCsv(CSV);
    expect(resolveCity(index, 'CN-3205')).toEqual({
      id: 'CN-3205',
      name: { zh: '苏州市', en: 'Suzhou' },
      country: 'CN',
      population: 12748262,
      area: 8657.32,
      location: { type: 'Point', coordinates: [120.619444444, 31.3] }
    });
  });

  test('Hong Kong province id resolves with country CN', () => {
    const index = parseRegionsCsv(CSV);
    const city = resolveCity(index, 'CN-81');
    expect(city.id).toBe('CN-81');
    expect(city.country).toBe('CN');
    expect(city.population).toBe(7413070);
  });

  test('unknown id throws', () => {
    const index = parseRegionsCsv(CSV);
    expect(() => resolveCity(index, 'HK')).toThrow(/not found/);
  });
});

describe('placeholderCity', () => {
  test('carries only the region id', () => {
    expect(placeholderCity('CN-81')).toEqual({
      id: 'CN-81',
      name: { zh: 'CN-81', en: 'CN-81' },
      country: '',
      population: null,
      area: null,
      location: null
    });
  });
});
