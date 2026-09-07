// Civil (proleptic Gregorian) date math on epoch days, no timezone.
// Uses Howard Hinnant's well-known days-from-civil algorithms — exact, integer,
// branch-light, valid for the full range we care about.

export interface YMD {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

const idiv = (a: number, b: number): number => Math.floor(a / b);

/** y-m-d (m in 1..12) -> days since 1970-01-01. */
export function ymdToEpochDay(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = idiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = idiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** days since 1970-01-01 -> y-m-d. */
export function epochDayToYMD(epochDay: number): YMD {
  const z = epochDay + 719468;
  const era = idiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100)); // [0, 365]
  const mp = idiv(5 * doy + 2, 153); // [0, 11]
  const d = doy - idiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Add whole calendar months to an epoch day, clamping the day to the target month. */
export function addMonths(epochDay: number, months: number): number {
  const { y, m, d } = epochDayToYMD(epochDay);
  const total = y * 12 + (m - 1) + months;
  const ny = idiv(total, 12);
  const nm = total - ny * 12 + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return ymdToEpochDay(ny, nm, nd);
}
