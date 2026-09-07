// compile = typecheck + dependency extraction. The result carries the inferred
// type (stored on the column) and the dependency edges the store uses to order
// per-record recompute and to reverse-index cross-record rollups. Errors are
// returned, not thrown, so the editor renders them inline against the formula.

import type { ErrCode, ValueType } from '@core/values';
import type { Node } from './ast.ts';
import type { TypeCtx } from './typecheck.ts';
import { inferType, isFail } from './typecheck.ts';

export interface CompiledColumn {
  id: string;
  type: ValueType;
  deps: string[]; // same-record column ids this reads (for topo order)
  rollupDeps: { via: string; column: string }[]; // cross-record deps (reverse-indexed by the store)
  ast: Node;
}
export interface CompileError {
  code: ErrCode;
  message: string;
}

function collect(node: Node, deps: Set<string>, rollups: { via: string; column: string }[]): void {
  switch (node.op) {
    case 'lit':
      return;
    case 'field':
      deps.add(node.id);
      return;
    case 'ref':
      deps.add(node.path[0]); // the local reference column this hop starts from
      return;
    case 'rollup': {
      const col = node.of.op === 'field' ? node.of.id : '*';
      rollups.push({ via: node.via, column: col });
      return;
    }
    case 'not':
    case 'neg':
      collect(node.args[0], deps, rollups);
      return;
    case 'call':
      for (const a of node.args) collect(a, deps, rollups);
      return;
    default:
      // binary
      if ('args' in node) for (const a of node.args) collect(a, deps, rollups);
  }
}

export function compile(
  id: string,
  formula: Node,
  ctx: TypeCtx,
): CompiledColumn | { errors: CompileError[] } {
  const t = inferType(formula, ctx);
  if (isFail(t)) return { errors: [{ code: t.err, message: t.msg }] };

  const deps = new Set<string>();
  const rollupDeps: { via: string; column: string }[] = [];
  collect(formula, deps, rollupDeps);
  deps.delete(id); // never depend on self through name collision

  return { id, type: t, deps: [...deps], rollupDeps, ast: formula };
}
