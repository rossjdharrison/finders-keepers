// Total value -> display string. Reuses @core/values for money/date so the client
// never re-implements the value semantics. Errors render as their bare code
// (ErrCode already carries the leading '#', so no extra prefix).

import type { Value } from '@core/values';
import { moneyFormat, epochDayToYMD } from '@core/values';
import type { EnumOption } from './types.ts';

const pad = (n: number): string => String(n).padStart(2, '0');
const label = (id: string, options?: EnumOption[]): string => options?.find((o) => o.id === id)?.label ?? id;

export function format(v: Value | undefined, options?: EnumOption[]): string {
  if (!v) return '';
  switch (v.t) {
    case 'num':
      return String(v.v);
    case 'money':
      return moneyFormat(v);
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
      return `[${v.items.length}]`;
    case 'blank':
      return '';
    case 'error':
      return v.detail ? `${v.code} (${v.detail})` : v.code;
  }
}
