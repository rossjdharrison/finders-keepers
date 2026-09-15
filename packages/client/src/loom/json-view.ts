// The JSON tab — the underlying model, made discoverable. It shows the EFFECTIVE cassette the sealed @core
// actually runs (a flat/composed cassette with any saved edits applied, or a journey's COMPILED cassette),
// so "the model is the app / the logic is data" is inspectable in one click. View + copy + download for any
// subject. A flat/composed cassette is also EDITABLE here: edit the JSON, it is validated in a throwaway
// core (previewCassette: HQDM reduce + typecheck + acyclicity + a non-error sample), and on success saved as
// the model override the player hot-reloads — a page reload re-seeds under the new model. A journey's
// compiled JSON is DERIVED (from its proposition + interaction), so it is view-only here; edit it via the
// Compositie tab and the configurators' Regels.

import type { Cassette } from '@app/core-runtime';
import { previewCassette } from '../model-edit.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function downloadJson(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface JsonViewOpts {
  cassette: Cassette; // the effective model the core runs
  editable: boolean; // flat/composed only (a journey's compiled JSON is derived → view-only)
  storageKey?: string; // fk-cassette-model-<id>, for save/revert (when editable)
  edited?: boolean; // an override is currently active (so "Herstellen" is meaningful)
  note?: string; // context line (e.g. for a journey)
}

export function renderJsonView(panel: HTMLElement, opts: JsonViewOpts): void {
  const json = JSON.stringify(opts.cassette, null, 2);
  const fileName = `${opts.cassette.id ?? 'cassette'}.json`;

  panel.append(el('p', 'lm-panel-intro', opts.note
    ?? 'De onderliggende JSON die de verzegelde @core uitvoert — dít ís het model. Er is geen aparte code per product; deze data is de app. Bekijk, kopieer of download het, of pas het direct aan.'));

  const bar = el('div', 'lm-json-bar');
  const status = el('span', 'lm-json-status');
  const mkBtn = (label: string): HTMLButtonElement => {
    const b = el('button', 'lm-json-btn', label) as HTMLButtonElement;
    b.type = 'button';
    return b;
  };
  const flash = (msg: string): void => { status.textContent = msg; status.dataset.state = 'ok'; setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2000); };

  const pre = el('pre', 'lm-json') as HTMLPreElement;
  pre.textContent = json;
  const ta = document.createElement('textarea');
  ta.className = 'lm-json-edit';
  ta.value = json;
  ta.spellcheck = false;
  ta.hidden = true;

  const currentText = (): string => (ta.hidden ? pre.textContent ?? '' : ta.value);

  const copy = mkBtn('Kopiëren');
  copy.addEventListener('click', () => {
    const text = currentText();
    navigator.clipboard?.writeText(text).then(() => flash('Gekopieerd naar klembord')).catch(() => flash('Kopiëren niet gelukt'));
  });
  const download = mkBtn('Download .json');
  download.addEventListener('click', () => { downloadJson(fileName, currentText()); flash(`${fileName} gedownload`); });
  bar.append(copy, download);

  if (opts.editable && opts.storageKey) {
    const editToggle = mkBtn('Bewerken');
    const apply = mkBtn('Toepassen');
    const cancel = mkBtn('Annuleren');
    const revert = mkBtn('Herstellen');
    apply.classList.add('is-primary');
    apply.hidden = true;
    cancel.hidden = true;
    revert.hidden = !opts.edited;

    editToggle.addEventListener('click', () => {
      ta.hidden = false;
      pre.hidden = true;
      editToggle.hidden = true;
      apply.hidden = false;
      cancel.hidden = false;
      status.textContent = '';
      status.dataset.state = '';
      ta.focus();
    });
    const stopEditing = (): void => {
      ta.hidden = true;
      pre.hidden = false;
      editToggle.hidden = false;
      apply.hidden = true;
      cancel.hidden = true;
    };
    // the player's live row snapshot lives at a sibling key; its signature deliberately ignores rate/literal
    // values, so a value-only edit shares the shipped signature. Clearing it on apply/revert forces a fresh
    // re-seed under the effective model — otherwise a revert restores premiums computed under the reverted rule.
    const snapKey = opts.storageKey!.replace('fk-cassette-model-', 'fk-cassette-');
    const fail = (msg: string): void => { status.textContent = msg; status.dataset.state = 'error'; };
    cancel.addEventListener('click', () => { ta.value = pre.textContent ?? json; stopEditing(); status.textContent = ''; status.dataset.state = ''; });
    apply.addEventListener('click', () => {
      let parsed: Cassette;
      try {
        parsed = JSON.parse(ta.value) as Cassette;
      } catch (e) {
        fail(`Ongeldige JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // don't let the id drift — the override key + the Model/Aanvraag navigation are keyed on it
      if (parsed.id !== opts.cassette.id) { fail(`Wijzig het veld 'id' niet (nu '${opts.cassette.id}') — dat ontkoppelt de opslag en navigatie.`); return; }
      // prove the edited model in a throwaway core before it can touch the running one
      const res = previewCassette(parsed);
      if (!res.ok) { fail(`Model afgewezen: ${res.error ?? 'ongeldig model'}`); return; }
      // previewCassette treats a MISSING output field as a valid blank; guard it explicitly so a renamed/
      // removed premium field can't be saved into a silently non-quoting model
      const out = ((parsed as { journey?: { summary?: { total?: string } } }).journey?.summary?.total) ?? 'premium';
      const hasOut = (parsed.collections ?? []).some((c) => (c.properties ?? []).some((p) => p.id === out));
      if (!hasOut) { fail(`Uitvoerveld '${out}' ontbreekt — het model zou geen bedrag berekenen. Hernoem ook journey.summary.total mee.`); return; }
      try {
        localStorage.setItem(opts.storageKey!, JSON.stringify(parsed));
        localStorage.removeItem(snapKey); // drop the stale runtime snapshot → the player re-seeds under this model
      } catch {
        fail('Opslaan niet gelukt (privémodus?).');
        return;
      }
      status.textContent = 'Toegepast — de aanvraag draait nu dit model. Pagina herlaadt…';
      status.dataset.state = 'ok';
      setTimeout(() => location.reload(), 350);
    });
    revert.addEventListener('click', () => {
      try {
        localStorage.removeItem(opts.storageKey!);
        localStorage.removeItem(snapKey); // also drop the runtime snapshot, else a value-only edit's price lingers
      } catch { /* ignore */ }
      setTimeout(() => location.reload(), 100);
    });
    bar.append(editToggle, apply, cancel, revert);
  }

  bar.append(status);
  panel.append(bar, pre, ta);
}
