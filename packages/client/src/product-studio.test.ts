import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduces } from '@core/ontology';
import { collections, types } from './product-studio.ts';

// The demo is HQDM-based from day one: this pins it, so a future edit that adds an
// un-grounded collection or field category fails here (as well as at PUT time).
test('every Product Studio collection + tagged field reduces to HQDM', () => {
  for (const c of collections) {
    assert.ok(c.semanticClass, `${c.id} declares a semanticClass`);
    assert.ok(reduces(c.semanticClass, types), `${c.id}.semanticClass '${c.semanticClass}' reduces to HQDM`);
    for (const p of c.properties) {
      const cat = (p as { category?: string }).category;
      if (cat) assert.ok(reduces(cat, types), `${c.id}.${p.id} category '${cat}' reduces to HQDM`);
    }
  }
});
