// A tiny, total expression parser/printer for the Loom's journey-composition editor — the finders-keepers
// analogue of wasm-calculator's formatExpr↔parseExpr. It turns a binding's mapping/condition AST into
// readable infix text you can edit, and parses the edited text back into an AST. It NEVER typechecks:
// validity is delegated to the real compiler (compileJourney → previewCassette), exactly as the rules
// editor does — so there is zero parser-parity risk with the engine. parse errors throw with a message.
//
// Grammar (low→high precedence): ||  &&  == !=  < <= > >=  + -  * /  unary(- !)  primary.
// primary: number | €money | "text" | true | false | blank | set:value (enum) | ident | dotted.ref
//        | fn(args) | lookup(table, key[, key2]) | ( expr )

// A formula AST node — loosely typed here (the client does not depend on @core/formula; the real
// typecheck happens in the engine via compileJourney/previewCassette). `op` discriminates the shape.
export type Node = { op: string; [k: string]: unknown };

const BINS = new Set(['add', 'sub', 'mul', 'div', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'and', 'or']);
const isBin = (op: string): boolean => BINS.has(op);

// ---- print (AST → text) -------------------------------------------------------------------------

const OP_TEXT: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/', eq: '==', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', and: '&&', or: '||' };
const PREC: Record<string, number> = { or: 1, and: 2, eq: 3, ne: 3, lt: 4, lte: 4, gt: 4, gte: 4, add: 5, sub: 5, mul: 6, div: 6 };

const trimNum = (x: number): string => {
  // a stable decimal without a forced .00 (so 41000 prints as "41000", 250.5 as "250.5")
  if (Number.isInteger(x)) return String(x);
  return String(x);
};

function formatLit(v: { t?: string; v?: unknown; minor?: unknown; set?: string }): string {
  switch (v.t) {
    case 'num': return trimNum(Number(v.v));
    case 'money': return `€${trimNum(Number(v.minor) / 100)}`;
    case 'bool': return v.v ? 'true' : 'false';
    case 'blank': return 'blank';
    case 'enum': return `${v.set}:${v.v}`;
    case 'text': return JSON.stringify(String(v.v ?? ''));
    default: return JSON.stringify(v);
  }
}

/** Render an AST node as editable infix text. Minimal parentheses (precedence-aware). */
export function formatExpr(node: unknown): string {
  const n = node as { op?: string; id?: string; path?: string[]; value?: { t?: string }; args?: unknown[]; fn?: string; table?: string; key?: unknown; key2?: unknown; agg?: string; via?: string; of?: unknown; name?: string };
  if (!n || typeof n !== 'object') return String(node);
  switch (n.op) {
    case 'field': return n.id ?? '?';
    case 'ref': return (n.path ?? []).join('.');
    case 'lit': return formatLit((n.value ?? {}) as { t?: string });
    case 'not': return `!${child(n.args?.[0], 7)}`;
    case 'neg': return `-${child(n.args?.[0], 7)}`;
    case 'lookup': return `lookup(${n.table}, ${formatExpr(n.key)}${n.key2 ? `, ${formatExpr(n.key2)}` : ''})`;
    case 'rollup': return `${n.agg}(${n.via}, ${formatExpr(n.of)})`; // display only (mappings never contain rollups)
    case 'call': return `${n.fn}(${(n.args ?? []).map(formatExpr).join(', ')})`;
    case 'signal': return String(n.name ?? '?');
    default:
      if (n.op && isBin(n.op) && n.args?.length === 2) {
        const p = PREC[n.op];
        // left child needs parens if strictly lower prec; right child if lower-or-equal (left-assoc)
        return `${childBin(n.args[0], p, false)} ${OP_TEXT[n.op]} ${childBin(n.args[1], p, true)}`;
      }
      return JSON.stringify(n);
  }
}
function child(node: unknown, _minPrec: number): string {
  const s = formatExpr(node);
  const n = node as { op?: string; args?: unknown[] };
  return n && isBin(n.op ?? '') ? `(${s})` : s;
}
function childBin(node: unknown, parentPrec: number, isRight: boolean): string {
  const n = node as { op?: string; args?: unknown[] };
  const s = formatExpr(node);
  if (n && typeof n === 'object' && n.op && isBin(n.op) && n.args?.length === 2) {
    const cp = PREC[n.op];
    if (cp < parentPrec || (isRight && cp === parentPrec)) return `(${s})`;
  }
  return s;
}

// ---- parse (text → AST) -------------------------------------------------------------------------

interface Tok { t: 'num' | 'str' | 'ident' | 'op' | 'eof'; v: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const two = new Set(['<=', '>=', '==', '!=', '&&', '||']);
  const one = new Set(['+', '-', '*', '/', '<', '>', '!', '(', ')', ',', '.', ':', '€']);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      const numStr = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(numStr)) throw new Error(`ongeldig getal '${numStr}'`); // reject 1.2.3, 5.., etc.
      toks.push({ t: 'num', v: numStr });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') { s += src[j]; j++; }
      if (j >= src.length) throw new Error('ontbrekend sluitend aanhalingsteken');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.has(pair)) { toks.push({ t: 'op', v: pair }); i += 2; continue; }
    if (one.has(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`onbekend teken '${c}'`);
  }
  toks.push({ t: 'eof', v: '' });
  return toks;
}

class Parser {
  private p = 0;
  private depth = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.t === 'op' && t.v === v; }
  private eat(v: string): void { if (!this.isOp(v)) throw new Error(`verwacht '${v}'`); this.p++; }
  // bound recursion so pathological nesting throws a clean parse error, not a stack-overflow RangeError
  private nest<T>(fn: () => T): T { if (++this.depth > 300) throw new Error('uitdrukking te diep genest'); try { return fn(); } finally { this.depth--; } }

  parse(): Node {
    const n = this.or();
    if (this.peek().t !== 'eof') throw new Error(`onverwacht '${this.peek().v}'`);
    return n;
  }
  private binLevel(next: () => Node, ops: Record<string, string>): Node {
    let left = next();
    while (this.peek().t === 'op' && ops[this.peek().v]) {
      const op = ops[this.next().v];
      const right = next();
      left = { op, args: [left, right] } as Node;
    }
    return left;
  }
  private or(): Node { return this.nest(() => this.binLevel(() => this.and(), { '||': 'or' })); }
  private and(): Node { return this.binLevel(() => this.equality(), { '&&': 'and' }); }
  private equality(): Node { return this.binLevel(() => this.comparison(), { '==': 'eq', '!=': 'ne' }); }
  private comparison(): Node { return this.binLevel(() => this.additive(), { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' }); }
  private additive(): Node { return this.binLevel(() => this.multiplicative(), { '+': 'add', '-': 'sub' }); }
  private multiplicative(): Node { return this.binLevel(() => this.unary(), { '*': 'mul', '/': 'div' }); }
  private unary(): Node {
    return this.nest(() => {
      if (this.isOp('-')) { this.next(); return { op: 'neg', args: [this.unary()] } as Node; }
      if (this.isOp('!')) { this.next(); return { op: 'not', args: [this.unary()] } as Node; }
      return this.primary();
    });
  }
  private primary(): Node {
    const t = this.peek();
    if (this.isOp('(')) { this.next(); const n = this.or(); this.eat(')'); return n; }
    if (this.isOp('€')) { this.next(); const numTok = this.next(); if (numTok.t !== 'num') throw new Error('verwacht een bedrag na €'); return { op: 'lit', value: { t: 'money', minor: Math.round(Number(numTok.v) * 100), ccy: 'EUR', scale: 2 } } as Node; }
    if (t.t === 'num') { this.next(); return { op: 'lit', value: { t: 'num', v: Number(t.v) } } as Node; }
    if (t.t === 'str') { this.next(); return { op: 'lit', value: { t: 'text', v: t.v } } as Node; }
    if (t.t === 'ident') {
      this.next();
      if (t.v === 'true' || t.v === 'false') return { op: 'lit', value: { t: 'bool', v: t.v === 'true' } } as Node;
      if (t.v === 'blank') return { op: 'lit', value: { t: 'blank' } } as Node;
      // enum literal: set:value
      if (this.isOp(':')) { this.next(); const val = this.next(); if (val.t !== 'ident') throw new Error('verwacht een enum-waarde na :'); return { op: 'lit', value: { t: 'enum', set: t.v, v: val.v } } as Node; }
      // call or lookup
      if (this.isOp('(')) {
        this.next();
        if (t.v === 'lookup') {
          const table = this.next();
          if (table.t !== 'ident') throw new Error('lookup verwacht een tabelnaam');
          this.eat(',');
          const key = this.or();
          let key2: Node | undefined;
          if (this.isOp(',')) { this.next(); key2 = this.or(); }
          this.eat(')');
          return (key2 ? { op: 'lookup', table: table.v, key, key2 } : { op: 'lookup', table: table.v, key }) as Node;
        }
        const args: Node[] = [];
        if (!this.isOp(')')) { args.push(this.or()); while (this.isOp(',')) { this.next(); args.push(this.or()); } }
        this.eat(')');
        return { op: 'call', fn: t.v, args } as Node;
      }
      // dotted ref (a.b.c) else a bare field
      if (this.isOp('.')) {
        const path = [t.v];
        while (this.isOp('.')) { this.next(); const seg = this.next(); if (seg.t !== 'ident') throw new Error('verwacht een veldnaam na .'); path.push(seg.v); }
        return { op: 'ref', path } as Node;
      }
      return { op: 'field', id: t.v } as Node;
    }
    throw new Error(`onverwacht '${t.v || 'einde'}'`);
  }
}

/** Parse editable infix text into a formula AST. Throws with a Dutch message on a syntax error.
 * Does NOT typecheck — hand the result to compileJourney/previewCassette for that. */
export function parseExpr(src: string): Node {
  const trimmed = src.trim();
  if (!trimmed) throw new Error('lege uitdrukking');
  return new Parser(tokenize(trimmed)).parse();
}
