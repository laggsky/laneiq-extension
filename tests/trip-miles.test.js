'use strict';

// Unit tests for parseTripMiles — the pure TRIP-miles parser extracted from
// content.js's getDetailTripMiles. content.js is an IIFE that exports this
// helper under Node (browser bootstrap is guarded behind `typeof document`),
// so requiring it here is side-effect-free.
const { parseTripMiles } = require('../new/dat-matcher/content.js');

describe('parseTripMiles — live repro cases (the 52635 / 12657 bug)', () => {
  // Root cause: the rate panel renders Total | Trip | Rate/mile values as adjacent
  // .data-item siblings with NO separator, so the container's textContent fuses the
  // Total dollar value's trailing digit onto Trip ("$2,765" + "2,635 mi" → "52635").
  //
  // Fix A (primary, in getDetailTripMiles): read ONLY the Trip value's own cell by
  // label↔item index pairing → parseTripMiles sees the isolated "2,635 mi" → 2635.
  // Fix B (defense, here): the left-bounded regex (?<![\d.]) guarantees that even if
  // the fused container text is ever parsed, it can NEVER yield the bug value 52635.

  test('Concord→Buffalo: isolated Trip cell reads 2635 (fix A), and the fused text never yields 52635 (fix B)', () => {
    expect(parseTripMiles('2,635 mi')).toBe(2635);                 // what getDetailTripMiles now reads
    expect(parseTripMiles('$2,7652,635 mi')).not.toBe(52635);      // fused Total+Trip can't produce the bug value
  });

  test('Concord→Hickory: isolated Trip cell reads 2657 (fix A), and the fused text never yields 12657 (fix B)', () => {
    expect(parseTripMiles('2,657 mi')).toBe(2657);
    expect(parseTripMiles('$2,7612,657 mi')).not.toBe(12657);
  });
});

describe('parseTripMiles — Trip-vs-DH cases (8)', () => {
  // 1. Lone trip value, no deadhead anywhere → take the "<n> mi".
  test('1: lone trip value', () => {
    expect(parseTripMiles('Trip 1,409 mi')).toBe(1409);
  });

  // 2. DH present, value AFTER trip → anchor to trip, never the deadhead.
  test('2: trip then DH — returns trip, not DH', () => {
    expect(parseTripMiles('Trip 2,635 mi DH 68')).toBe(2635);
  });

  // 3. DH-O value BEFORE trip → must skip the leading deadhead number.
  test('3: DH-O before trip — returns trip, not DH-O', () => {
    expect(parseTripMiles('DH-O 120 Trip 2,144 mi')).toBe(2144);
  });

  // 4. "Deadhead" spelled out, with its own "<n> mi" after trip → still trip.
  test('4: deadhead word with its own mi — returns trip', () => {
    expect(parseTripMiles('Trip 850 mi Deadhead 45 mi')).toBe(850);
  });

  // 5. No commas in the trip number.
  test('5: trip value without commas', () => {
    expect(parseTripMiles('2635 mi')).toBe(2635);
  });

  // 6. DH leaf before trip, both carry "mi" → anchor wins over the DH value.
  test('6: "DH 68 mi" before trip — returns trip', () => {
    expect(parseTripMiles('DH 68 mi Trip 2,657 mi')).toBe(2657);
  });

  // 7. No parseable miles at all → 0.
  test('7: no miles present', () => {
    expect(parseTripMiles('Trip Total Rate / mile')).toBe(0);
  });

  // 8. Five-digit trip with a trailing DH → full trip captured, DH ignored.
  test('8: five-digit trip with trailing DH', () => {
    expect(parseTripMiles('Trip 12,345 mi DH 200')).toBe(12345);
  });
});
