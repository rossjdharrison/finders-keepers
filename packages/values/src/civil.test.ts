import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymdToEpochDay, epochDayToYMD, addMonths } from './civil.ts';

test('epoch-day round trips across leap boundaries', () => {
  for (const [y, m, d] of [
    [1970, 1, 1],
    [2000, 2, 29],
    [2024, 2, 29],
    [1999, 12, 31],
    [2026, 9, 7],
    [1837, 6, 20],
  ] as const) {
    const ed = ymdToEpochDay(y, m, d);
    assert.deepEqual(epochDayToYMD(ed), { y, m, d });
  }
});

test('1970-01-01 is epoch day 0', () => {
  assert.equal(ymdToEpochDay(1970, 1, 1), 0);
});

test('addMonths clamps the day to the shorter target month', () => {
  // 2024-01-31 + 1 month -> 2024-02-29 (leap), not an overflow into March
  const jan31 = ymdToEpochDay(2024, 1, 31);
  assert.deepEqual(epochDayToYMD(addMonths(jan31, 1)), { y: 2024, m: 2, d: 29 });
  // + 13 months crosses a year
  assert.deepEqual(epochDayToYMD(addMonths(jan31, 13)), { y: 2025, m: 2, d: 28 });
});
