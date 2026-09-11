// The Compositie EDITOR — alter a journey doc's whole composition in the Loom, then save it so the
// player runs the edited journey (recompiled through the same sealed @core). Every edit is a pure op
// from journey-edit.ts, proven by previewJourney (compile + throwaway-core load) BEFORE it commits —
// exactly the validate-before-commit contract the rules editor uses. The composition graph re-renders
// after each edit; the binding mappings/conditions are edited as free-text expressions (expr.ts), the
// finders-keepers analogue of wasm-calculator's journey-loom seam editor ("boxes drill, wires edit").

import type { Cassette } from '@app/core-runtime';
import { format } from '../format.ts';
import type { JourneyDoc } from '../compile-journey.ts';
import { buildJourneyGraph, renderJourneyGraph } from './journey-graph.ts';
import { formatExpr, parseExpr, type Node } from './expr.ts';
import {
  addBinding, removeBinding, setBindingMapping, setBindingCondition,
  addModel, removeModel, addSurface, removeSurface, setTotalOf,
  setSectionLabel, moveSection, toggleSectionField, setMinimal,
  previewJourney, loadJourneyDoc, saveJourneyDoc, clearJourneyDoc, hasJourneyOverride,
  bindingVar, bindingTarget, bindingSource,
} from './journey-edit.ts';
import { neededFields } from './data-minimization.ts';

interface FieldInfo { id: string; label: string; k: string; source: string }

export interface CompositionEditorOpts {
  shippedDoc: JourneyDoc;
  registry: Record<string, Cassette>; // product cassettes (REGISTRY)
  label: (id: string) => string;
  loomHref: (ref: string) => string;
  onSaved?: () => void; // called after a successful save (the host can refresh its other views)
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const opt = (value: string, text: string): HTMLOptionElement => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
};

export function renderCompositionEditor(mount: HTMLElement, opts: CompositionEditorOpts): void {
  const { shippedDoc, registry } = opts;
  const id = shippedDoc.id;
  let doc: JourneyDoc = structuredClone(loadJourneyDoc(id, shippedDoc).doc);
  let dirty = false;
  let banner = '';

  const cassOf = (alias: string): Cassette | undefined => registry[doc.models.find((m) => m.as === alias)?.ref ?? ''];
  const fieldsOf = (alias: string): FieldInfo[] => {
    const cass = cassOf(alias);
    return ((cass?.collections[0]?.properties ?? []) as { id: string; valueType: { k: string }; source?: string }[]).map((p) => ({ id: p.id, label: opts.label(p.id), k: p.valueType.k, source: p.source ?? 'stored' }));
  };
  const modelLabel = (alias: string): string => { const m = doc.models.find((x) => x.as === alias); return m ? registry[m.ref]?.title ?? m.ref : alias; };

  // apply a candidate doc iff it still compiles; else surface the compiler's own message and change nothing.
  // `defer` re-renders on the next tick — used after an expr field's change (which fires on blur), so the
  // click that caused the blur lands on the still-present control instead of a detached one.
  const commit = (candidate: JourneyDoc, defer = false): boolean => {
    const res = previewJourney(candidate, registry);
    if (!res.ok) { banner = res.error ?? 'ongeldige compositie'; render(); return false; }
    doc = candidate;
    dirty = true;
    banner = '';
    if (defer) setTimeout(render, 0);
    else render();
    return true;
  };

  function render(): void {
    // preserve keyboard focus across the full rebuild: a checkbox/button toggle keeps its focus, so a
    // keyboard user isn't dropped to <body> on every edit (the app's journey renderer does the same).
    const ae = document.activeElement as HTMLElement | null;
    const focusKey = ae?.dataset?.focusKey;
    const selStart = ae instanceof HTMLInputElement && ae.type === 'text' ? ae.selectionStart : null;
    mount.replaceChildren();
    const root = el('div', 'lm-ce');

    // the live composition graph (rebuilt from the working doc); wires labelled with the value they carry,
    // the MONEY flows (the critical value path) drawn boldest.
    const graphHolder = el('div');
    const targetIsMoney = (b: { to: string; contract: { requires: { target: string }[] } }): boolean => {
      const cass = cassOf(b.to);
      const tf = (b.contract.requires[0]?.target ?? '').split(':')[1] ?? '';
      return (cass?.collections[0]?.properties ?? []).some((p) => p.id === tf && (p as { valueType?: { k?: string } }).valueType?.k === 'money');
    };
    renderJourneyGraph(graphHolder, buildJourneyGraph(doc, { label: (ref) => registry[ref]?.title ?? ref, fieldLabel: opts.label, targetIsMoney }), { loomHref: opts.loomHref });
    root.append(graphHolder);

    if (banner) {
      const b = el('div', 'lm-ce-banner');
      b.setAttribute('role', 'alert'); // announce a rejected edit to assistive tech
      b.dataset.state = 'error';
      b.textContent = `✗ ${banner}`;
      root.append(b);
    }

    const cols = el('div', 'lm-ce-cols');
    const main = el('div', 'lm-ce-main');

    main.append(sectionModels());
    main.append(sectionBindings());
    main.append(sectionSummary());
    main.append(sectionSteps());
    cols.append(main);
    cols.append(sidePreview());
    root.append(cols);
    mount.append(root);

    if (focusKey) {
      let restored = mount.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      // the same-key control can come back disabled (a move button pushed to a boundary) — fall back to the
      // section's opposite move button so keyboard focus isn't dropped to <body>.
      if (restored && (restored as HTMLButtonElement).disabled) {
        const alt = focusKey.endsWith(':up') ? focusKey.slice(0, -3) + ':down' : focusKey.endsWith(':down') ? focusKey.slice(0, -5) + ':up' : null;
        const altEl = alt ? mount.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(alt)}"]`) : null;
        if (altEl) restored = altEl;
      }
      if (restored && !(restored as HTMLButtonElement).disabled) {
        restored.focus({ preventScroll: true });
        if (selStart != null && restored instanceof HTMLInputElement) try { restored.setSelectionRange(selStart, selStart); } catch { /* not selectable */ }
      }
    }
  }

  // --- Modellen -------------------------------------------------------------------------------
  function sectionModels(): HTMLElement {
    const sec = el('section', 'lm-ce-sec');
    sec.append(el('h3', 'lm-ce-h', 'Configuratoren'));
    sec.append(el('p', 'lm-ce-sub', 'De configurators in de reis. De spine draagt het gecombineerde totaal en kan niet worden verwijderd.'));
    const list = el('div', 'lm-ce-list');
    for (const m of doc.models) {
      const row = el('div', 'lm-ce-row');
      const name = el('span', 'lm-ce-row-name', modelLabel(m.as));
      row.append(name);
      row.append(el('span', 'lm-mono lm-ce-row-sub', `${m.as} · ${m.ref}`));
      if (m.as === doc.spine) row.append(el('span', 'lm-tag lm-tag-live', 'spine'));
      else {
        const rm = el('button', 'lm-ce-x', '×') as HTMLButtonElement;
        rm.type = 'button';
        rm.title = 'Model verwijderen';
        rm.setAttribute('aria-label', `Model ${modelLabel(m.as)} verwijderen`);
        rm.addEventListener('click', () => commit(removeModel(doc, m.as)));
        row.append(rm);
      }
      list.append(row);
    }
    sec.append(list);

    // add-model: a select of registry cassettes not already present
    const present = new Set(doc.models.map((m) => m.ref));
    const addable = Object.values(registry).filter((c) => !present.has(c.id));
    if (addable.length) {
      const form = el('div', 'lm-ce-form');
      const sel = document.createElement('select');
      sel.className = 'lm-ce-select';
      sel.setAttribute('aria-label', 'Kies een product om toe te voegen');
      sel.append(opt('', 'Configurator toevoegen…'));
      for (const c of addable) sel.append(opt(c.id, c.title ?? c.id));
      const btn = el('button', 'lm-ce-add', 'Toevoegen') as HTMLButtonElement;
      btn.type = 'button';
      btn.addEventListener('click', () => { if (sel.value) commit(addModel(doc, sel.value, registry)); });
      form.append(sel, btn);
      sec.append(form);
    }
    return sec;
  }

  // --- Bindingen ------------------------------------------------------------------------------
  function sectionBindings(): HTMLElement {
    const sec = el('section', 'lm-ce-sec');
    sec.append(el('h3', 'lm-ce-h', 'Bindingen (naden)'));
    sec.append(el('p', 'lm-ce-sub', 'Elke binding leidt een waarde uit één product naar een invoerveld van een ander: het doelveld wordt berekend (vast) via een rollup. De mapping-uitdrukking gebruikt de aangeleverde variabele; een optionele voorwaarde zet het doel op nul als ze onwaar is.'));
    const list = el('div', 'lm-ce-list');
    for (const b of doc.bindings) {
      const card = el('div', 'lm-ce-binding');
      const head = el('div', 'lm-ce-binding-head');
      head.append(el('span', 'lm-mono lm-ce-bfrom', `${b.from}.${bindingSource(b)}`));
      head.append(el('span', 'lm-rel-arrow', '→'));
      head.append(el('span', 'lm-mono lm-ce-bto', `${b.to}.${bindingTarget(b)}`));
      const rm = el('button', 'lm-ce-x', '×') as HTMLButtonElement;
      rm.type = 'button';
      rm.title = 'Binding verwijderen';
      rm.setAttribute('aria-label', `Binding ${b.id} verwijderen`);
      rm.addEventListener('click', () => commit(removeBinding(doc, b.id)));
      head.append(rm);
      card.append(head);

      const va = bindingVar(b);
      card.append(exprField(`mapping — beschikbaar: ${va}`, formatExpr(b.mapping?.[0]?.from ?? { op: 'field', id: va }), (node) => setBindingMapping(doc, b.id, node!)));
      card.append(exprField('voorwaarde (optioneel, leeg = altijd)', b.condition ? formatExpr(b.condition) : '', (node) => setBindingCondition(doc, b.id, node), true));
      list.append(card);
    }
    sec.append(list);
    sec.append(addBindingForm());
    return sec;
  }

  // a labelled free-text expression input, validated live, committed on change
  function exprField(labelText: string, value: string, toDoc: (node: Node | undefined) => JourneyDoc, allowEmpty = false): HTMLElement {
    const wrap = el('label', 'lm-ce-expr');
    wrap.append(el('span', 'lm-ce-expr-label', labelText));
    const input = document.createElement('input');
    input.className = 'cell-input lm-ce-expr-input lm-mono';
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    input.maxLength = 2000; // bound the input so a pathological paste can't reach the parser's depth guard
    input.setAttribute('aria-label', labelText);
    const status = el('span', 'lm-ce-expr-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite'); // announce the live validity result
    const validate = (): { ok: boolean; candidate?: JourneyDoc } => {
      const text = input.value.trim();
      if (!text) {
        if (allowEmpty) { status.textContent = ''; status.dataset.state = ''; return { ok: true, candidate: toDoc(undefined) }; }
        status.textContent = 'leeg'; status.dataset.state = 'error'; return { ok: false };
      }
      let node: Node;
      try { node = parseExpr(text); } catch (e) { status.textContent = e instanceof Error ? e.message : 'ongeldig'; status.dataset.state = 'error'; return { ok: false }; }
      const candidate = toDoc(node);
      const res = previewJourney(candidate, registry);
      if (!res.ok) { status.textContent = res.error ?? 'ongeldig'; status.dataset.state = 'error'; return { ok: false }; }
      status.textContent = '✓'; status.dataset.state = 'positive';
      return { ok: true, candidate };
    };
    input.addEventListener('input', validate);
    input.addEventListener('change', () => { const v = validate(); if (v.ok && v.candidate) commit(v.candidate, true); });
    wrap.append(input, status);
    return wrap;
  }

  function addBindingForm(): HTMLElement {
    const form = el('div', 'lm-ce-form lm-ce-addbind');
    const fromSel = document.createElement('select');
    fromSel.className = 'lm-ce-select';
    fromSel.setAttribute('aria-label', 'Van model');
    const fromFieldSel = document.createElement('select');
    fromFieldSel.className = 'lm-ce-select';
    fromFieldSel.setAttribute('aria-label', 'Van veld');
    const toSel = document.createElement('select');
    toSel.className = 'lm-ce-select';
    toSel.setAttribute('aria-label', 'Naar model');
    const toFieldSel = document.createElement('select');
    toFieldSel.className = 'lm-ce-select';
    toFieldSel.setAttribute('aria-label', 'Naar veld');

    const fillModels = (sel: HTMLSelectElement): void => { sel.replaceChildren(); for (const m of doc.models) sel.append(opt(m.as, modelLabel(m.as))); };
    fillModels(fromSel);
    fillModels(toSel);
    if (doc.models.length > 1) toSel.selectedIndex = 1;
    const fillFrom = (): void => { fromFieldSel.replaceChildren(); for (const f of fieldsOf(fromSel.value)) fromFieldSel.append(opt(f.id, `${f.label} · ${f.k}`)); };
    // bindable targets: stored money/num fields (the rollup sums them)
    const fillTo = (): void => { toFieldSel.replaceChildren(); for (const f of fieldsOf(toSel.value).filter((f) => f.source === 'stored' && (f.k === 'money' || f.k === 'num'))) toFieldSel.append(opt(f.id, `${f.label} · ${f.k}`)); };
    fromSel.addEventListener('change', fillFrom);
    toSel.addEventListener('change', fillTo);
    fillFrom();
    fillTo();

    const btn = el('button', 'lm-ce-add', 'Binding toevoegen') as HTMLButtonElement;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (!fromSel.value || !toSel.value || !fromFieldSel.value || !toFieldSel.value) return;
      if (fromSel.value === toSel.value) { banner = 'een binding moet twee verschillende modellen verbinden'; render(); return; }
      commit(addBinding(doc, { from: fromSel.value, to: toSel.value, fromField: fromFieldSel.value, toField: toFieldSel.value }));
    });
    form.append(el('span', 'lm-ce-form-label', 'Nieuw:'), fromSel, fromFieldSel, el('span', 'lm-rel-arrow', '→'), toSel, toFieldSel, btn);
    return form;
  }

  // --- Samenvatting (surface + total) ---------------------------------------------------------
  function sectionSummary(): HTMLElement {
    const sec = el('section', 'lm-ce-sec');
    sec.append(el('h3', 'lm-ce-h', 'Samenvatting'));
    sec.append(el('p', 'lm-ce-sub', 'Regels uit toeleverende configurators die op de spine worden getoond, en welke velden optellen tot het gecombineerde totaal.'));

    // surfaced lines
    const surf = el('div', 'lm-ce-list');
    for (const s of doc.surface ?? []) {
      const row = el('div', 'lm-ce-row');
      row.append(el('span', 'lm-ce-row-name', s.label ?? s.as));
      row.append(el('span', 'lm-mono lm-ce-row-sub', `${s.from}.${s.field}`));
      const rm = el('button', 'lm-ce-x', '×') as HTMLButtonElement;
      rm.type = 'button';
      rm.setAttribute('aria-label', `Regel ${s.label ?? s.as} verwijderen`);
      rm.addEventListener('click', () => commit(removeSurface(doc, s.as)));
      row.append(rm);
      surf.append(row);
    }
    sec.append(surf);

    // add surface: a child (non-spine) model + one of its money fields
    const children = doc.models.filter((m) => m.as !== doc.spine);
    if (children.length) {
      const form = el('div', 'lm-ce-form');
      const mSel = document.createElement('select');
      mSel.className = 'lm-ce-select';
      mSel.setAttribute('aria-label', 'Uit model');
      for (const m of children) mSel.append(opt(m.as, modelLabel(m.as)));
      const fSel = document.createElement('select');
      fSel.className = 'lm-ce-select';
      fSel.setAttribute('aria-label', 'Veld om te tonen');
      const fillF = (): void => { fSel.replaceChildren(); for (const f of fieldsOf(mSel.value).filter((f) => f.k === 'money')) fSel.append(opt(f.id, f.label)); };
      mSel.addEventListener('change', fillF);
      fillF();
      const btn = el('button', 'lm-ce-add', 'Regel tonen') as HTMLButtonElement;
      btn.type = 'button';
      btn.addEventListener('click', () => { if (mSel.value && fSel.value) commit(addSurface(doc, { from: mSel.value, field: fSel.value, label: opts.label(fSel.value) })); });
      form.append(el('span', 'lm-ce-form-label', 'Toon:'), mSel, fSel, btn);
      sec.append(form);
    }

    // total.of: which spine fields sum into the combined total
    sec.append(el('div', 'lm-ce-total-head', 'Totaal telt op:'));
    const spineCass = cassOf(doc.spine);
    const spineMoney = ((spineCass?.collections[0]?.properties ?? []) as { id: string; valueType: { k: string }; source?: string }[]).filter((p) => p.valueType.k === 'money' && p.source === 'computed').map((p) => p.id);
    const candidates = [...(doc.surface ?? []).map((s) => s.as), ...spineMoney];
    const chosen = new Set(doc.total.of);
    const chips = el('div', 'lm-ce-chips');
    for (const c of candidates) {
      const chip = el('label', 'lm-ce-chip');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.has(c);
      cb.dataset.focusKey = `total:${c}`;
      cb.addEventListener('change', () => {
        const of = cb.checked ? [...doc.total.of, c] : doc.total.of.filter((x) => x !== c);
        commit(setTotalOf(doc, of)); // commit() always re-renders, so the box reflects the committed (or reverted) state
      });
      chip.append(cb, el('span', undefined, opts.label(c)));
      chips.append(chip);
    }
    sec.append(chips);
    return sec;
  }

  // --- Stappen & secties (step order + which fields each configurator shows) ------------------
  function sectionSteps(): HTMLElement {
    const sec = el('section', 'lm-ce-sec');
    sec.append(el('h3', 'lm-ce-h', 'Stappen & secties'));
    sec.append(el('p', 'lm-ce-sub', 'De volgorde van de stappen in de reis en welke velden elke configurator toont. Gebruik de pijlen om te herordenen.'));

    // privacy by design: derive each section's fields from what the journey provably needs (data
    // minimization). On → the fields are computed and read-only; off → you pick them by hand.
    const privacy = el('label', 'lm-ce-privacy');
    const pcb = document.createElement('input');
    pcb.type = 'checkbox';
    pcb.checked = !!doc.minimal;
    pcb.dataset.focusKey = 'minimal';
    pcb.addEventListener('change', () => commit(setMinimal(doc, pcb.checked)));
    privacy.append(pcb, el('span', 'lm-ce-privacy-label', 'Privacy by design — toon alleen de velden die de reis nodig heeft (dataminimalisatie)'));
    sec.append(privacy);

    doc.sections.forEach((s, idx) => {
      const card = el('div', 'lm-ce-section');
      const head = el('div', 'lm-ce-section-head');
      const moves = el('div', 'lm-ce-moves');
      const up = el('button', 'lm-ce-move', '↑') as HTMLButtonElement;
      up.type = 'button';
      up.title = 'Eerder';
      up.dataset.focusKey = `move:${s.model}:up`;
      up.disabled = idx === 0; // boundary reorder is a no-op — disable it (no spurious dirty)
      up.setAttribute('aria-label', `Sectie ${s.label} eerder in de reis`);
      up.addEventListener('click', () => commit(moveSection(doc, s.model, -1)));
      const down = el('button', 'lm-ce-move', '↓') as HTMLButtonElement;
      down.type = 'button';
      down.title = 'Later';
      down.dataset.focusKey = `move:${s.model}:down`;
      down.disabled = idx === doc.sections.length - 1;
      down.setAttribute('aria-label', `Sectie ${s.label} later in de reis`);
      down.addEventListener('click', () => commit(moveSection(doc, s.model, 1)));
      moves.append(up, down);
      head.append(moves);
      const labelInput = document.createElement('input');
      labelInput.className = 'cell-input lm-ce-section-label';
      labelInput.type = 'text';
      labelInput.value = s.label;
      labelInput.dataset.focusKey = `label:${s.model}`;
      labelInput.setAttribute('aria-label', `Naam van de sectie voor ${modelLabel(s.model)}`);
      // commit a non-blank rename; a cleared label snaps back to the current one (a visible cue, no silent drop)
      labelInput.addEventListener('change', () => { const v = labelInput.value.trim(); if (v) commit(setSectionLabel(doc, s.model, v), true); else labelInput.value = s.label; });
      head.append(labelInput);
      head.append(el('span', 'lm-mono lm-ce-section-model', s.model));
      card.append(head);

      const chips = el('div', 'lm-ce-fieldchips');
      if (doc.minimal) {
        // DERIVED: show every field of the model, marked shown (needed) / provided (by a binding) / hidden
        // (collected-but-unused). Read-only — you can't over-collect, because "needed" is computed.
        const min = neededFields(doc, s.model, registry);
        const boundN = fieldsOf(s.model).length - min.shown.length - min.hidden.length; // supplied by a binding
        const note = el('div', 'lm-ce-minmsg');
        const parts = [`${min.shown.length} getoond`];
        if (boundN > 0) parts.push(`${boundN} aangeleverd`);
        if (min.hidden.length) parts.push(`${min.hidden.length} niet verzameld`);
        note.textContent = parts.join(' · ') + (min.hidden.length ? ' (privacy by design)' : '');
        card.append(note);
        for (const f of fieldsOf(s.model)) {
          const shown = min.shown.includes(f.id);
          const provided = !shown && !min.hidden.includes(f.id); // a binding supplies it upstream
          const chip = el('label', `lm-ce-fieldchip ${shown ? '' : provided ? 'lm-ce-fieldchip-bound' : 'lm-ce-fieldchip-off'}`.trim());
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = shown;
          cb.disabled = true;
          chip.title = shown ? 'nodig voor dit proces' : provided ? 'aangeleverd door een binding' : 'niet verzameld — privacy by design';
          chip.append(cb, el('span', undefined, f.label));
          chips.append(chip);
        }
      } else {
        for (const f of fieldsOf(s.model)) {
          const chip = el('label', 'lm-ce-fieldchip');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = s.fields.includes(f.id);
          cb.dataset.focusKey = `chip:${s.model}:${f.id}`;
          // a section needs at least one field, else the player would skip the whole configurator — so the
          // last remaining checked field can't be unchecked.
          if (cb.checked && s.fields.length <= 1) { cb.disabled = true; chip.title = 'een sectie toont minstens één veld'; }
          cb.addEventListener('change', () => commit(toggleSectionField(doc, s.model, f.id)));
          chip.append(cb, el('span', undefined, f.label));
          chips.append(chip);
        }
      }
      card.append(chips);
      sec.append(card);
    });
    return sec;
  }

  // --- preview + save -------------------------------------------------------------------------
  function sidePreview(): HTMLElement {
    const aside = el('aside', 'lm-ce-side');
    const card = el('div', 'quote');
    card.append(el('div', 'quote-eyebrow', 'Voorbeeld — gecombineerd maandbedrag'));
    const res = previewJourney(doc, registry);
    const hero = el('div', 'quote-hero');
    const amount = el('div', 'quote-amount lm-ce-total', res.ok && res.total ? format(res.total) : '—');
    hero.append(amount);
    card.append(hero);
    const status = el('div', 'adm-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = res.ok ? '✓ Compositie geldig' : `✗ ${res.error ?? 'ongeldig'}`;
    status.dataset.state = res.ok ? 'positive' : 'error';
    card.append(status);

    const actions = el('div', 'adm-actions');
    const save = el('button', 'j-btn j-next', 'Compositie opslaan') as HTMLButtonElement;
    save.type = 'button';
    save.disabled = !res.ok || !dirty;
    save.addEventListener('click', () => {
      if (!previewJourney(doc, registry).ok) return;
      saveJourneyDoc(id, doc);
      dirty = false;
      render();
      opts.onSaved?.(); // let the host refresh dependent views (the Loom's Structuur/Grafiek tabs)
    });
    const revert = el('button', 'j-btn', 'Terugzetten naar standaard') as HTMLButtonElement;
    revert.type = 'button';
    revert.addEventListener('click', () => { clearJourneyDoc(id); doc = structuredClone(shippedDoc); dirty = false; banner = ''; render(); });
    actions.append(save, revert);
    card.append(actions);
    const note = el('div', 'adm-saved', dirty ? 'Niet-opgeslagen wijzigingen' : hasJourneyOverride(id) ? 'Opgeslagen — de aanvraag gebruikt deze compositie.' : 'Standaardcompositie.');
    card.append(note);
    aside.append(card);
    return aside;
  }

  render();
}
