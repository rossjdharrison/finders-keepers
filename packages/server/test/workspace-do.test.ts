import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { CollectionDoc } from '../src/workspace-do.ts';

// --- value + node builders (wire JSON) --------------------------------------
const num = (v: number) => ({ t: 'num', v });
const text = (v: string) => ({ t: 'text', v });
const en = (set: string, v: string) => ({ t: 'enum', set, v });
const ref = (collection: string, id: string) => ({ t: 'ref', collection, id });
const field = (id: string) => ({ op: 'field', id });
const lit = (value: unknown) => ({ op: 'lit', value });
const rollup = (via: string, agg: string, of: string) => ({ op: 'rollup', via, agg, of: field(of) });
const stored = (id: string, valueType: unknown) => ({ id, valueType, source: 'stored' });
const computed = (id: string, valueType: unknown, formula: unknown) => ({ id, valueType, source: 'computed', formula });

const collections: CollectionDoc[] = [
  {
    id: 'initiatives',
    semanticClass: 'Initiative',
    properties: [
      stored('name', { k: 'text' }),
      computed('totalPoints', { k: 'num' }, rollup('features', 'sum', 'points')),
    ],
  } as CollectionDoc,
  {
    id: 'features',
    semanticClass: 'Feature',
    properties: [
      stored('name', { k: 'text' }),
      stored('initiative', { k: 'ref', collection: 'initiatives' }),
      stored('points', { k: 'num' }),
      computed('effort', { k: 'num' }, rollup('tasks', 'sum', 'hours')),
      computed('taskCount', { k: 'num' }, rollup('tasks', 'count', 'hours')),
      computed('taskDone', { k: 'num' }, rollup('tasks', 'sum', 'doneFlag')),
      computed('progress', { k: 'num' }, {
        op: 'call', fn: 'if', args: [
          { op: 'gt', args: [field('taskCount'), lit(num(0))] },
          { op: 'div', args: [field('taskDone'), field('taskCount')] },
          lit(num(0)),
        ],
      }),
    ],
  } as CollectionDoc,
  {
    id: 'tasks',
    semanticClass: 'Task',
    properties: [
      stored('title', { k: 'text' }),
      stored('feature', { k: 'ref', collection: 'features' }),
      stored('status', { k: 'enum', set: 'taskStatus' }),
      stored('hours', { k: 'num' }),
      computed('doneFlag', { k: 'num' }, {
        op: 'call', fn: 'if', args: [
          { op: 'eq', args: [field('status'), lit(en('taskStatus', 'done'))] },
          lit(num(1)), lit(num(0)),
        ],
      }),
    ],
  } as CollectionDoc,
];
const relations = {
  features: { parentColl: 'initiatives', childColl: 'features', childField: 'initiative' },
  tasks: { parentColl: 'features', childColl: 'tasks', childField: 'feature' },
};
const types = {
  Initiative: { specializes: ['activity'] },
  Feature: { specializes: ['activity'] },
  Task: { specializes: ['activity'] },
};

// Every call carries a bearer token the DO verifies (dev-admin → the bootstrap admin
// a-admin, from wrangler.jsonc's WORKSPACE_AUTH). Pass a different token, or null for
// none, to exercise the write-gate. GET carries no body.
const call = (path: string, body: unknown, method = 'POST', token: string | null = 'dev-admin') =>
  SELF.fetch('https://x' + path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
const ops = (coll: string, list: unknown[], token: string | null = 'dev-admin') =>
  call(`/collections/${coll}/ops`, { ops: list }, 'POST', token);
const rowsOf = async (coll: string) =>
  ((await (await call(`/collections/${coll}/query`, { coll })).json()) as { rows: { id: string; doc: Record<string, { v?: number }> }[] }).rows;
const featureById = async (id: string) => (await rowsOf('features')).find((r) => r.id === id)!;

async function seed() {
  expect((await call('/workspace', { collections, relations, types }, 'PUT')).ok).toBe(true);
  await ops('initiatives', [{ op: 'insert', coll: 'initiatives', row: 'i1', values: { name: text('Realtime') } }]);
  await ops('features', [
    { op: 'insert', coll: 'features', row: 'f1', values: { name: text('Presence'), initiative: ref('initiatives', 'i1'), points: num(8) } },
    { op: 'insert', coll: 'features', row: 'f2', values: { name: text('Threads'), initiative: ref('initiatives', 'i1'), points: num(5) } },
  ]);
  await ops('tasks', [
    { op: 'insert', coll: 'tasks', row: 't1', values: { title: text('a'), feature: ref('features', 'f1'), status: en('taskStatus', 'done'), hours: num(6) } },
    { op: 'insert', coll: 'tasks', row: 't2', values: { title: text('b'), feature: ref('features', 'f1'), status: en('taskStatus', 'todo'), hours: num(4) } },
  ]);
}

describe('WorkspaceDO relations + rollups', () => {
  it('rolls up child fields on insert (effort, taskCount, taskDone, progress) and up to the initiative', async () => {
    await seed();
    const f1 = await featureById('f1');
    expect(f1.doc.effort.v).toBe(10); // 6 + 4
    expect(f1.doc.taskCount.v).toBe(2);
    expect(f1.doc.taskDone.v).toBe(1); // one task done
    expect(f1.doc.progress.v).toBe(0.5);
    const i1 = (await rowsOf('initiatives'))[0];
    expect(i1.doc.totalPoints.v).toBe(13); // 8 + 5
  });

  it('a leaf edit cascades UP: Task.hours -> Feature.effort (no task computed col changes)', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'hours', value: num(20) }]);
    expect((await featureById('f1')).doc.effort.v).toBe(24); // 20 + 4
  });

  it('rollup-of-computed + computed-from-rollup: Task.status done -> Feature.taskDone/progress', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't2', field: 'status', value: en('taskStatus', 'done') }]);
    const f1 = await featureById('f1');
    expect(f1.doc.taskDone.v).toBe(2);
    expect(f1.doc.progress.v).toBe(1);
  });

  it('re-pointing a ref updates BOTH the old and the new parent', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'feature', value: ref('features', 'f2') }]);
    expect((await featureById('f1')).doc.effort.v).toBe(4); // lost t1
    expect((await featureById('f2')).doc.effort.v).toBe(6); // gained t1
  });

  it('broadcast rows and query rows carry their collection', async () => {
    await seed();
    const res = await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'hours', value: num(9) }]);
    const body = (await res.json()) as { rows: { coll: string }[] };
    expect(body.rows.every((r) => r.coll === 'features' || r.coll === 'tasks')).toBe(true);
    expect(body.rows.some((r) => r.coll === 'features')).toBe(true); // f1 cascaded
  });

  it('rejects a workspace whose semanticClass does not reduce to HQDM (and does not persist it)', async () => {
    const bad = await call('/workspace', {
      collections: [{ id: 'gizmos', semanticClass: 'Gizmo', properties: [stored('name', { k: 'text' })] }],
      relations: {},
      types: { Gizmo: { specializes: ['nowhere'] } }, // dangles — never reaches the lattice root
    }, 'PUT');
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toHaveProperty('error');
    // ...and a well-formed one on a fresh collection is accepted
    const good = await call('/workspace', {
      collections: [{ id: 'gizmos', semanticClass: 'Gizmo', properties: [stored('name', { k: 'text' })] }],
      relations: {},
      types: { Gizmo: { specializes: ['ordinary_physical_object'] } },
    }, 'PUT');
    expect(good.ok).toBe(true);
  });

  it('rejects a collection with no semanticClass at all', async () => {
    const r = await call('/workspace', {
      collections: [{ id: 'x', properties: [stored('n', { k: 'text' })] }],
      relations: {}, types: {},
    }, 'PUT');
    expect(r.status).toBe(400);
  });
});

describe('WorkspaceDO lookup + availableWhen (the configurator primitives)', () => {
  const optCols: CollectionDoc[] = [
    {
      id: 'opts',
      semanticClass: 'Option',
      properties: [
        stored('title', { k: 'text' }),
        stored('size', { k: 'enum', set: 'sz' }),
        stored('purpose', { k: 'enum', set: 'purp' }),
        // a field only in play when purpose = perf (category-driven reshaping)
        { id: 'target', valueType: { k: 'num' }, source: 'stored', availableWhen: { op: 'eq', args: [field('purpose'), lit(en('purp', 'perf'))] } },
        // effort computed DOWN from the size choice via a lookup table
        computed('effort', { k: 'num' }, { op: 'lookup', table: 'sizing', key: field('size') }),
      ],
      tables: { sizing: { kind: '1d', of: { k: 'num' }, map: { S: num(2), M: num(5), L: num(13) } } },
    } as CollectionDoc,
  ];

  it('lookup computes a consequence from a table; availableWhen yields per-record hidden fields', async () => {
    expect((await call('/workspace', { collections: optCols, relations: {}, types: { Option: { specializes: ['sign'] } } }, 'PUT')).ok).toBe(true);
    await ops('opts', [
      { op: 'insert', coll: 'opts', row: 'o1', values: { title: text('a'), size: en('sz', 'M'), purpose: en('purp', 'perf'), target: num(50) } },
      { op: 'insert', coll: 'opts', row: 'o2', values: { title: text('b'), size: en('sz', 'L'), purpose: en('purp', 'safety') } },
    ]);
    const rows = ((await (await call('/collections/opts/query', { coll: 'opts' })).json()) as { rows: { id: string; doc: Record<string, { v?: number }>; hidden?: string[] }[] }).rows;
    const o1 = rows.find((r) => r.id === 'o1')!;
    const o2 = rows.find((r) => r.id === 'o2')!;
    expect(o1.doc.effort.v).toBe(5); // lookup(sizing, M)
    expect(o2.doc.effort.v).toBe(13); // lookup(sizing, L)
    expect(o1.hidden ?? []).not.toContain('target'); // purpose = perf -> target is in play
    expect(o2.hidden ?? []).toContain('target'); // purpose != perf -> target gated off
  });
});

describe('WorkspaceDO verification seam (a transition gated by met)', () => {
  const reqCols: CollectionDoc[] = [
    {
      id: 'reqs',
      semanticClass: 'Requirement',
      properties: [
        stored('title', { k: 'text' }),
        stored('status', { k: 'enum', set: 'st' }),
        stored('comparator', { k: 'enum', set: 'cmp' }),
        stored('observable', { k: 'enum', set: 'metric' }),
        stored('target', { k: 'num' }),
        stored('measured', { k: 'num' }),
        computed('criterionExpr', { k: 'predicate' }, { op: 'build', cmp: field('comparator'), observable: field('observable'), threshold: field('target') }),
        computed('met', { k: 'bool' }, { op: 'check', pred: field('criterionExpr'), evidence: field('measured') }),
      ],
      transitions: [{ id: 'verify', field: 'status', from: 'accepted', to: 'verified', when: field('met') }],
    } as CollectionDoc,
  ];
  const seedReq = async (row: string, measured: number) => {
    await ops('reqs', [{ op: 'insert', coll: 'reqs', row, values: {
      title: text(row), status: en('st', 'accepted'), comparator: en('cmp', 'lte'), observable: en('metric', 'latency_ms'), target: num(200), measured: num(measured),
    } }]);
  };
  const statusOf = async (id: string) =>
    (((await (await call('/collections/reqs/query', { coll: 'reqs' })).json()) as { rows: { id: string; doc: Record<string, { v?: string }> }[] }).rows.find((r) => r.id === id))!.doc.status.v;

  it('permits accepted -> verified when met, refuses it (fail-closed) when not', async () => {
    expect((await call('/workspace', { collections: reqCols, relations: {}, types: { Requirement: { specializes: ['sign'] } } }, 'PUT')).ok).toBe(true);
    await seedReq('r-ok', 180); // 180 <= 200 -> met
    await seedReq('r-bad', 250); // 250 <= 200 -> not met

    const ok = await ops('reqs', [{ op: 'setField', coll: 'reqs', row: 'r-ok', field: 'status', value: en('st', 'verified') }]);
    expect(ok.ok).toBe(true);
    expect(await statusOf('r-ok')).toBe('verified');

    const bad = await ops('reqs', [{ op: 'setField', coll: 'reqs', row: 'r-bad', field: 'status', value: en('st', 'verified') }]);
    expect(bad.status).toBe(400); // guard not satisfied -> the move is refused
    expect(await statusOf('r-bad')).toBe('accepted'); // and nothing changed
  });
});

describe('WorkspaceDO evidence/spec split (a requirement is a class; met is classification)', () => {
  const cmpLtePred = { op: 'build', cmp: field('comparator'), observable: field('observable'), threshold: field('target') };
  const cols: CollectionDoc[] = [
    {
      id: 'reqs2', semanticClass: 'Requirement',
      properties: [
        stored('title', { k: 'text' }), stored('status', { k: 'enum', set: 'st' }),
        stored('comparator', { k: 'enum', set: 'cmp' }), stored('observable', { k: 'enum', set: 'metric' }), stored('target', { k: 'num' }),
        computed('criterionExpr', { k: 'predicate' }, cmpLtePred),
        computed('metCount', { k: 'num' }, rollup('obs2', 'sum', 'metNum')),
      ],
      transitions: [{ id: 'verify', field: 'status', from: 'accepted', to: 'verified', category: 'event', when: { op: 'gt', args: [field('metCount'), lit(num(0))] } }],
    } as CollectionDoc,
    {
      id: 'obs2', semanticClass: 'Observation',
      properties: [
        stored('requirement', { k: 'ref', collection: 'reqs2' }), stored('measured', { k: 'num' }),
        computed('metNum', { k: 'num' }, {
          op: 'call', fn: 'if',
          args: [{ op: 'check', pred: { op: 'ref', path: ['requirement', 'criterionExpr'] }, evidence: field('measured') }, lit(num(1)), lit(num(0))],
        }),
      ],
    } as CollectionDoc,
  ];
  const relations2 = { obs2: { parentColl: 'reqs2', childColl: 'obs2', childField: 'requirement' } };
  const types2 = { Requirement: { specializes: ['requirement_specification'] }, Observation: { specializes: ['state'] } };
  const statusOf2 = async (id: string) =>
    (((await (await call('/collections/reqs2/query', { coll: 'reqs2' })).json()) as { rows: { id: string; doc: Record<string, { v?: string | number }> }[] }).rows.find((r) => r.id === id))!.doc;

  it('an observation is classified against its requirement criterion; the requirement verifies only when some observation satisfies it', async () => {
    expect((await call('/workspace', { collections: cols, relations: relations2, types: types2 }, 'PUT')).ok).toBe(true);
    await ops('reqs2', [
      { op: 'insert', coll: 'reqs2', row: 'q1', values: { title: text('fast'), status: en('st', 'accepted'), comparator: en('cmp', 'lte'), observable: en('metric', 'latency_ms'), target: num(200) } },
      { op: 'insert', coll: 'reqs2', row: 'q2', values: { title: text('faster'), status: en('st', 'accepted'), comparator: en('cmp', 'lte'), observable: en('metric', 'latency_ms'), target: num(200) } },
    ]);
    // an observation classifies against its OWN requirement's criterion (cross-record check)
    await ops('obs2', [
      { op: 'insert', coll: 'obs2', row: 'o1', values: { requirement: ref('reqs2', 'q1'), measured: num(180) } }, // 180 <= 200 -> satisfies
      { op: 'insert', coll: 'obs2', row: 'o2', values: { requirement: ref('reqs2', 'q2'), measured: num(250) } }, // 250 <= 200 -> does not
    ]);
    const obs = ((await (await call('/collections/obs2/query', { coll: 'obs2' })).json()) as { rows: { id: string; doc: Record<string, { v?: number }> }[] }).rows;
    expect(obs.find((r) => r.id === 'o1')!.doc.metNum.v).toBe(1);
    expect(obs.find((r) => r.id === 'o2')!.doc.metNum.v).toBe(0);
    // the requirement rolls up how many observations satisfy it
    expect((await statusOf2('q1')).metCount.v).toBe(1);
    expect((await statusOf2('q2')).metCount.v).toBe(0);
    // verify is gated on having a satisfying observation
    expect((await ops('reqs2', [{ op: 'setField', coll: 'reqs2', row: 'q1', field: 'status', value: en('st', 'verified') }])).ok).toBe(true);
    expect((await statusOf2('q1')).status.v).toBe('verified');
    expect((await ops('reqs2', [{ op: 'setField', coll: 'reqs2', row: 'q2', field: 'status', value: en('st', 'verified') }])).status).toBe(400);
    expect((await statusOf2('q2')).status.v).toBe('accepted');
  });
});

describe('WorkspaceDO schema-as-data (reflective Stage 2b)', () => {
  const cols: CollectionDoc[] = [
    {
      id: 'properties', semanticClass: 'class_of_association',
      properties: [stored('owner', { k: 'ref', collection: 'collections' }), stored('field', { k: 'text' }), stored('kind', { k: 'text' }), stored('valueType', { k: 'text' }), stored('source', { k: 'text' })],
    } as CollectionDoc,
    { id: 'collections', semanticClass: 'class_of_class', properties: [stored('semanticClass', { k: 'text' })] } as CollectionDoc,
    {
      id: 'widgets', semanticClass: 'Widget',
      properties: [stored('name', { k: 'text' }), stored('n', { k: 'num' }), computed('dbl', { k: 'num' }, { op: 'add', args: [field('n'), field('n')] })],
    } as CollectionDoc,
  ];

  it('a schema round-trips through Property-rows: properties are queryable, and a computed column reassembled from a row still recomputes', async () => {
    // PUT explodes every collection's schema into Property-rows, then re-sources the
    // live schema FROM those rows — so this asserts the reassembly is lossless.
    expect((await call('/workspace', { collections: cols, relations: {}, types: { Widget: { specializes: ['activity'] } } }, 'PUT')).ok).toBe(true);

    // the schema is now data: the `properties` collection is queryable
    const props = ((await (await call('/collections/properties/query', { coll: 'properties' })).json()) as {
      rows: { id: string; doc: Record<string, { t?: string; v?: string; id?: string }> }[];
    }).rows;
    const dbl = props.find((r) => r.id === 'widgets.dbl')!;
    expect(dbl).toBeTruthy();
    expect(dbl.doc.owner.id).toBe('widgets'); // owner is a ref into `collections`
    expect(dbl.doc.field.v).toBe('dbl');
    expect(dbl.doc.source.v).toBe('computed');
    expect(props.some((r) => r.id === 'widgets.n')).toBe(true);

    // the reassembled schema is LIVE: the computed column recomputes correctly
    await ops('widgets', [{ op: 'insert', coll: 'widgets', row: 'w1', values: { name: text('a'), n: num(21) } }]);
    const w = ((await (await call('/collections/widgets/query', { coll: 'widgets' })).json()) as { rows: { doc: Record<string, { v?: number }> }[] }).rows[0];
    expect(w.doc.dbl.v).toBe(42); // dbl = n + n, from a Property-row-sourced computed column
  });
});

describe('WorkspaceDO auth (every write is authored by a verified actor)', () => {
  // A workspace WITH the model's own actors/grants collections, so authorization is
  // MODEL-DRIVEN: the DO reads the grants rows to decide who may write.
  const authCols: CollectionDoc[] = [
    { id: 'actors', semanticClass: 'Actor', properties: [stored('name', { k: 'text' })] } as CollectionDoc,
    { id: 'grants', semanticClass: 'Grant', properties: [stored('actor', { k: 'ref', collection: 'actors' }), stored('scope', { k: 'enum', set: 'authScope' })] } as CollectionDoc,
    { id: 'notes', semanticClass: 'Note', properties: [stored('body', { k: 'text' })] } as CollectionDoc,
  ];
  const authTypes = { Actor: { specializes: ['party'] }, Grant: { specializes: ['association'] }, Note: { specializes: ['sign'] } };
  const insert = (coll: string, row: string, values: Record<string, unknown>) => ({ op: 'insert', coll, row, values });

  it('refuses unauthenticated (401) and unauthorized (403) writes fail-closed; a granted actor writes and is stamped with the VERIFIED id', async () => {
    // admin (dev-admin → a-admin, a bootstrapAdmin) establishes the schema…
    expect((await call('/workspace', { collections: authCols, relations: {}, types: authTypes }, 'PUT')).ok).toBe(true);
    // …and seeds the actors + a WRITE grant for a-agent (dev-agent), leaving a-observer ungranted
    await ops('actors', [insert('actors', 'a-agent', { name: text('Claude') }), insert('actors', 'a-observer', { name: text('Guest') })]);
    await ops('grants', [insert('grants', 'g-agent', { actor: ref('actors', 'a-agent'), scope: en('authScope', 'write') })]);

    const write = (token: string | null) => ops('notes', [insert('notes', 'n1', { body: text('hi') })], token);

    expect((await write(null)).status).toBe(401); // no token → unauthenticated
    expect((await write('dev-observer')).status).toBe(403); // authenticated, but no write grant
    expect((await rowsOf('notes')).length).toBe(0); // nothing persisted by either

    expect((await write('dev-agent')).ok).toBe(true); // a-agent has a write grant in the model
    expect((await rowsOf('notes')).length).toBe(1);

    // the oplog records the VERIFIED actor, never a client-declared string
    const log = (await (await call('/workspace/oplog', {}, 'GET')).json()) as { entries: { coll: string; actor: string }[] };
    expect(log.entries.find((e) => e.coll === 'notes')?.actor).toBe('a-agent');
  });

  it('a schema change requires admin: a write-only actor is refused (403)', async () => {
    const r = await call('/workspace', { collections: authCols, relations: {}, types: authTypes }, 'PUT', 'dev-agent');
    expect(r.status).toBe(403); // a-agent may write rows, but not change the schema
  });
});
