import { expect, test } from 'bun:test';
import { parseOfficialFareMatrix, parseOfficialLines } from '../src/fetch.ts';
import {
  extractAssignedLiteral,
  extractBalancedLiteral,
  jsLiteralToJson
} from '../src/js-literal.ts';

test('single-quoted strings and bare keys become JSON', () => {
  const json = jsLiteralToJson('{ title:\'1号线\', value:\'1\', lines:["陈官营", "东岗"] }');
  expect(JSON.parse(json)).toEqual({
    title: '1号线',
    value: '1',
    lines: ['陈官营', '东岗']
  });
});

test('trailing commas are dropped', () => {
  const json = jsLiteralToJson('{ "a": 1, "b": 2, }');
  expect(JSON.parse(json)).toEqual({ a: 1, b: 2 });
});

test('keywords and numbers pass through untouched', () => {
  const json = jsLiteralToJson('{ "t": true, "f": false, "n": null, "i": -3.5 }');
  expect(JSON.parse(json)).toEqual({ t: true, f: false, n: null, i: -3.5 });
});

test('comments are skipped', () => {
  const json = jsLiteralToJson(`{
    // a line comment
    "a": 1, /* a block comment */
    "b": 2
  }`);
  expect(JSON.parse(json)).toEqual({ a: 1, b: 2 });
});

test('brackets inside strings do not end the literal early', () => {
  const json = jsLiteralToJson('{ "a": "值]", "b": "值}" }');
  expect(JSON.parse(json)).toEqual({ a: '值]', b: '值}' });
});

test('escape sequences are decoded', () => {
  const json = jsLiteralToJson("{ a:'it\\'s', b:'line\\nbreak' }");
  expect(JSON.parse(json)).toEqual({ a: "it's", b: 'line\nbreak' });
});

test('a balanced literal is extracted from surrounding code', () => {
  const src = 'const lines = [ { a: 1 } ];\nconsole.log(lines);';
  const { text, end } = extractBalancedLiteral(src, src.indexOf('['));
  expect(text).toBe('[ { a: 1 } ]');
  expect(src.slice(end, end + 1)).toBe(';');
});

test('an assigned literal is extracted and converted', () => {
  const src = 'window.fareData = { "陈官营": { "东岗": 7 }, };';
  const json = extractAssignedLiteral(src, /window\.fareData\s*=/);
  expect(JSON.parse(json)).toEqual({ 陈官营: { 东岗: 7 } });
});

test("the operator's network literal parses into lines and stops", () => {
  const js = `
    const lines = [
        {
            title:'1号线',
            value:'1',
            lines:["陈官营", "奥体中心", "东岗"]
        },
         {
            title:'2号线',
            value:'2',
            lines:["东方红广场", "雁白大桥"]
        },
    ]
  `;
  const parsed = parseOfficialLines(js);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]!.title).toBe('1号线');
  expect(parsed[0]!.value).toBe('1');
  expect(parsed[0]!.lines).toEqual(['陈官营', '奥体中心', '东岗']);
  expect(parsed[1]!.lines).toEqual(['东方红广场', '雁白大桥']);
});

test('a malformed network literal is rejected', () => {
  expect(() => parseOfficialLines('const lines = [];')).toThrow(/non-empty array/);
  expect(() => parseOfficialLines('const lines = [{ title:"1号线" }];')).toThrow(/malformed/);
  expect(() => parseOfficialLines('const other = 1;')).toThrow(/did not match/);
});

test("the operator's fare matrix parses into a symmetric matrix", () => {
  const js = `
    window.fareData = {
      "陈官营": {
        "东岗": 7,
        "五里铺": 6,
      },
      "东岗": {
        "陈官营": 7,
      },
    };
  `;
  const matrix = parseOfficialFareMatrix(js);
  const chen = '陈官营';
  const dong = '东岗';
  expect(matrix[chen]![dong]).toBe(7);
  expect(matrix[dong]![chen]).toBe(7);
});
