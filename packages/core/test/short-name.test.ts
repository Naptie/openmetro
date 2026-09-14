import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveLineShortName, resolveLineShortName } from '../src/lines/short-name.js';

test('deriveLineShortName extracts leading numbered lines', () => {
  assert.equal(deriveLineShortName('1号线八通线'), '1');
  assert.equal(deriveLineShortName('4号线大兴线'), '4');
  assert.equal(deriveLineShortName('19号线'), '19');
  assert.equal(deriveLineShortName('10号线'), '10');
});

test('deriveLineShortName extracts S/T/APM codes', () => {
  assert.equal(deriveLineShortName('S1线'), 'S1');
  assert.equal(deriveLineShortName('亦庄T1线'), 'T1');
  assert.equal(deriveLineShortName('APM'), 'APM');
  assert.equal(deriveLineShortName('APM线'), 'APM');
});

test('deriveLineShortName never guesses', () => {
  // Chinese-numeral names have no derivable ASCII/numeric code.
  assert.equal(deriveLineShortName('一号线'), undefined);
  // Named lines without an official compact code.
  assert.equal(deriveLineShortName('浦江线'), undefined);
  assert.equal(deriveLineShortName('市域机场线'), undefined);
  assert.equal(deriveLineShortName('大兴机场线'), undefined);
  assert.equal(deriveLineShortName('西郊线'), undefined);
  assert.equal(deriveLineShortName('广州东环城际'), undefined);
  // A T-code glued to another ASCII token is not a T-line badge.
  assert.equal(deriveLineShortName('THP1线'), undefined);
  assert.equal(deriveLineShortName(''), undefined);
});

test('resolveLineShortName prefers the official short label', () => {
  assert.equal(resolveLineShortName('亦庄T1线', '亦庄T1'), '亦庄T1');
  assert.equal(resolveLineShortName('S1线', 'S1'), 'S1');
  assert.equal(resolveLineShortName('1号线八通线', '1'), '1');
  // Whitespace-only official labels are ignored.
  assert.equal(resolveLineShortName('2号线', '  '), '2');
});

test('resolveLineShortName falls back to derivation, then the name', () => {
  assert.equal(resolveLineShortName('2号线'), '2');
  assert.equal(resolveLineShortName('APM线'), 'APM');
  // No derivable code and no official label → the line's own name, never empty.
  assert.equal(resolveLineShortName('浦江线'), '浦江线');
  assert.equal(resolveLineShortName('市域机场线'), '市域机场线');
  assert.equal(resolveLineShortName('大兴机场线'), '大兴机场线');
});
