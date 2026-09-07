import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ValueType } from '@core/values';
import { moneyDec, enumV, date } from '@core/values';
import type { ViewSpec, Schema } from './view.ts';
import { compileView, compileGroupCounts } from './view.ts';

const schema: Schema = {
  stage: { k: 'enum', set: 'stage' },
  amount: { k: 'money', ccy: 'EUR' },
  closeDate: { k: 'date' },
  name: { k: 'text' },
};

test('a filtered, sorted board query compiles to parameterised SQL', () => {
  const spec: ViewSpec = {
    coll: 'deals',
    filter: {
      and: [
        { field: 'stage', op: 'eq', value: enumV('stage', 'won') },
        { field: 'amount', op: 'gte', value: moneyDec(1000, 'EUR') },
      ],
    },
    sort: [{ field: 'closeDate', dir: 'desc' }],
    page: { limit: 50 },
  };
  const { sql, params } = compileView(spec, schema);

  // money compares on integer minor units, guarded by currency; dates on epochDay
  assert.match(sql, /json_extract\(t\.doc, '\$\.stage\.v'\) = \?/);
  assert.match(sql, /CAST\(json_extract\(t\.doc, '\$\.amount\.minor'\) AS INTEGER\) >= \?/);
  assert.match(sql, /json_extract\(t\.doc, '\$\.amount\.ccy'\) = \?/);
  assert.match(sql, /ORDER BY json_extract\(t\.doc, '\$\.closeDate\.epochDay'\) DESC, t\.seq ASC/);
  assert.match(sql, /LIMIT 50$/);
  assert.match(sql, /t\.coll = \?/); // reads are scoped to the collection
  assert.deepEqual(params, ['deals', 'won', 100000, 'EUR']); // coll first, then 1000.00 EUR -> 100000 minor
});

test('empty / notEmpty / contains compile without a comparison param', () => {
  const c = compileView(
    { coll: 'deals', filter: { field: 'name', op: 'contains', value: { t: 'text', v: 'ac' } } },
    schema,
  );
  assert.match(c.sql, /json_extract\(t\.doc, '\$\.name\.v'\) LIKE \?/);
  assert.deepEqual(c.params, ['deals', '%ac%']);

  const e = compileView({ coll: 'deals', filter: { field: 'closeDate', op: 'empty' } }, schema);
  assert.match(e.sql, /json_extract\(t\.doc, '\$\.closeDate\.epochDay'\) IS NULL/);
  assert.deepEqual(e.params, ['deals']);
});

test('group counts produce a GROUP BY on the key', () => {
  const { sql } = compileGroupCounts({ coll: 'deals', group: { field: 'stage' } }, schema);
  assert.match(sql, /SELECT json_extract\(t\.doc, '\$\.stage\.v'\) AS k, COUNT\(\*\) AS c/);
  assert.match(sql, /GROUP BY k/);
});

test('unsafe field ids are rejected (no injection via json path)', () => {
  assert.throws(() =>
    compileView({ coll: 'x', filter: { field: "a') --", op: 'empty' } }, schema),
  );
});

test('an all-empty AND is a tautology, an empty OR is false', () => {
  assert.match(compileView({ coll: 'x', filter: { and: [] } }, schema).sql, /WHERE t\.deleted = 0 AND t\.coll = \? AND 1/);
  assert.match(compileView({ coll: 'x', filter: { or: [] } }, schema).sql, /WHERE t\.deleted = 0 AND t\.coll = \? AND 0/);
});
