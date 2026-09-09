// Total value -> display string. Reuses @core/values for money/date so the client
// never re-implements the value semantics. Errors render as their bare code
// (ErrCode already carries the leading '#', so no extra prefix).

import type { Value, VMoney } from '@core/values';
import { moneyFormat, epochDayToYMD } from '@core/values';
import type { EnumOption } from './types.ts';

const pad = (n: number): string => String(n).padStart(2, '0');
const label = (id: string, options?: EnumOption[]): string => options?.find((o) => o.id === id)?.label ?? id;

// --- locale-aware number / money formatting (display only; the value domain stays exact) ---
// OPT-IN: an app calls setLocale to get "€ 6.800,00" / "15.000" for its locale. Until then LOCALE is
// undefined and money/num fall back to the neutral debug forms — so a shared consumer that never sets
// a locale (e.g. the English main app) is unchanged. The cassette player calls setLocale(cass.locale).
let LOCALE: string | undefined;
export function setLocale(bcp47: string): void {
  LOCALE = bcp47;
}
const moneyFmts = new Map<string, Intl.NumberFormat>();
const numFmts = new Map<string, Intl.NumberFormat>();
function moneyLocale(m: VMoney): string {
  const key = `${LOCALE}:${m.ccy}`;
  let f = moneyFmts.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: m.ccy });
    moneyFmts.set(key, f);
  }
  // minor is an integer string in the currency's minor units; scale it to a major amount for display.
  return f.format(Number(String(m.minor)) / 10 ** m.scale);
}
function numLocale(n: number): string {
  const key = LOCALE!;
  let f = numFmts.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE);
    numFmts.set(key, f);
  }
  return f.format(n);
}

// A deferred predicate (a criterion) as a compact, readable expression string.
const CMP_SYM: Record<string, string> = { lte: '≤', lt: '<', gte: '≥', gt: '>', eq: '=', ne: '≠' };
function predicateStr(ast: unknown): string {
  const n = ast as { op?: string; name?: string; value?: Value; args?: unknown[] };
  if (!n || typeof n !== 'object') return '—';
  if (n.op === 'signal') return String(n.name ?? '?');
  if (n.op === 'lit') return format(n.value);
  if (n.op && CMP_SYM[n.op] && n.args?.length === 2) {
    return `${predicateStr(n.args[0])} ${CMP_SYM[n.op]} ${predicateStr(n.args[1])}`;
  }
  return n.op ?? '—';
}

export function format(v: Value | undefined, options?: EnumOption[]): string {
  if (!v) return '';
  switch (v.t) {
    case 'num':
      return LOCALE ? numLocale(v.v) : String(v.v);
    case 'money':
      return LOCALE ? moneyLocale(v) : moneyFormat(v);
    case 'pct':
      return `${(v.v * 100).toFixed(1)}%`;
    case 'text':
      return v.v;
    case 'bool':
      return v.v ? '✓' : '—';
    case 'date': {
      const { y, m, d } = epochDayToYMD(v.epochDay);
      return `${y}-${pad(m)}-${pad(d)}`;
    }
    case 'datetime':
      return new Date(v.epochMs).toISOString().slice(0, 16).replace('T', ' ');
    case 'enum':
      return label(v.v, options);
    case 'enumset':
      return v.v.map((id) => label(id, options)).join(', ');
    case 'dur':
      return `${v.months}mo ${Math.round(v.ms / 86_400_000)}d`;
    case 'ref':
      return v.id;
    case 'list':
      return v.items.length ? v.items.map((x) => format(x, options)).join(', ') : '[]';
    case 'predicate':
      return predicateStr(v.ast);
    case 'blank':
      return '';
    case 'error':
      return v.detail ? `${v.code} (${v.detail})` : v.code;
  }
}
